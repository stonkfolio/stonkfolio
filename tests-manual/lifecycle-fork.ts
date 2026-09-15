/**
 * Launch lifecycle against real Meteora programs on a local mainnet fork.
 * Start the fork first: `bash scripts/mainnet-fork-validator.sh 1`, then
 * `npm run test:mainnet-fork`.
 *
 * Covers: fee tier configs → launch → curve buys/transfers/sells with the fee
 * taken in SOL → keeper claims curve fees → swaps halt at 85 SOL → migrator
 * migrates → DAMM v2 charges the same fee in SOL → keeper claims position
 * fees → liquidity added and permanently locked while the pool is thin.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import BN from "bn.js";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { sendTransaction } from "../lib/send";
import { checkLaunchConfig } from "../keeper/meteora/launchConfig";
import { createFeeTierConfig, createLaunchPool } from "../keeper/meteora/launch";
import { claimCurveFees, curveSwap, readDbcPool } from "../keeper/meteora/dbc";
import {
  addLiquidityAndLock,
  claimPositionFees,
  dammSwap,
  findLockedPosition,
  readDammPool,
  unclaimedPositionFees,
} from "../keeper/meteora/dammv2";
import { migrateIfReady } from "../keeper/migrator";
import { decideLiquidity } from "../keeper/liquidity";
import { LaunchPriceSource } from "../keeper/meteora/price";
import { PYTH_SOL_USD_FEED_ID, PYTH_SOL_USD_PRICE_ACCOUNT, toMicroUsd } from "../lib/pyth";
import { CoinKeeper } from "../keeper/coin";
import { DistributorClient, isLeafClaimed } from "../keeper/distributor/client";
import { RpcProgramAccountsSource } from "../keeper/holders/source";
import { BasketSource, RoundEngine } from "../keeper/round/engine";
import { LocalDirectoryPublisher } from "../keeper/round/publisher";
import { readCommittedRoundHashes, verifyRoundArtifacts, verifyRoundOnChain } from "../keeper/round/verify";
import { readArtifacts } from "../lib/artifacts";
import { parseRoundInputs, prepareRound } from "../keeper/round/prepare";
import { KeeperStore } from "../keeper/state";
import * as os from "os";
import { createMint, createMintToInstruction } from "@solana/spl-token";

const RPC_URL = process.env.FORK_RPC ?? "http://127.0.0.1:8899";
const SOL = 1_000_000_000n;

async function expectFail(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err: any) {
    const text = `${err?.message ?? err}\n${(err?.logs ?? err?.transactionLogs ?? []).join("\n")}`;
    expect(text, text).to.match(pattern);
    return;
  }
  expect.fail(`expected failure matching ${pattern}`);
}

describe("launch lifecycle on a local mainnet fork", function () {
  this.timeout(900_000);

  const connection = new Connection(RPC_URL, "confirmed");
  const dbc = DynamicBondingCurveClient.create(connection, "confirmed");
  const cpAmm = new CpAmm(connection);
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(process.cwd(), ".keys/test-upgrade-authority.json"), "utf-8")))
  );
  const keeper = Keypair.generate();
  const migrator = Keypair.generate();
  const buyer = Keypair.generate();
  const holder = Keypair.generate();
  const configs: Record<number, PublicKey> = {};
  let pool: PublicKey;
  let baseMint: PublicKey;
  let dammPool: PublicKey;

  const balance = async (who: PublicKey) => BigInt(await connection.getBalance(who, "confirmed"));
  const tokenAccountRent = async () => BigInt(await connection.getMinimumBalanceForRentExemption(165));
  const tokenBalance = async (owner: PublicKey) =>
    (await getAccount(connection, getAssociatedTokenAddressSync(baseMint, owner), "confirmed")).amount;

  before(async () => {
    const funding: [PublicKey, bigint][] = [
      [keeper.publicKey, 20n * SOL],
      [migrator.publicKey, 5n * SOL],
      [buyer.publicKey, 300n * SOL],
      [holder.publicKey, SOL],
    ];
    await sendTransaction(
      connection,
      funding.map(([to, lamports]) => SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: lamports })),
      payer
    );
  });

  it("creates fee tier configs whose on-chain settings match the launch settings exactly", async () => {
    for (const feeBps of [300, 500]) {
      const { config } = await createFeeTierConfig(connection, dbc, payer, keeper.publicKey, feeBps);
      const account = await dbc.state.getPoolConfig(config);
      expect(account).to.not.equal(null);
      expect(
        checkLaunchConfig(account!, { feeBps, feeClaimer: keeper.publicKey, leftoverReceiver: keeper.publicKey, quoteMint: NATIVE_MINT })
      ).to.deep.equal([]);
      configs[feeBps] = config;
    }
  });

  it("launches a coin on the 5% tier with no mint or freeze authority left to abuse", async () => {
    ({ pool, baseMint } = await createLaunchPool(connection, dbc, keeper, configs[500], {
      name: "Stonkfolio",
      symbol: "FOLIO",
      uri: "https://example.invalid/stonkfolio.json",
    }));
    const mint = await getMint(connection, baseMint, "confirmed", TOKEN_PROGRAM_ID);
    console.log(`      mint authority ${mint.mintAuthority?.toBase58() ?? "none"}, freeze authority ${mint.freezeAuthority?.toBase58() ?? "none"}, supply ${mint.supply}`);
    expect(mint.freezeAuthority).to.equal(null);
    expect(mint.mintAuthority).to.equal(null);
    expect((await readDbcPool(dbc, pool)).phase).to.equal("CURVE");
  });

  it("reads the curve price the keeper uses for the $50 check", async () => {
    const price = await new LaunchPriceSource(dbc, cpAmm, pool).poolPrice();
    const lamportsIn = SOL / 100n;
    await curveSwap(connection, dbc, buyer, pool, lamportsIn, false, 100);
    const received = await tokenBalance(buyer.publicKey);
    // After the 5% fee, 0.0095 SOL should buy about 0.0095 SOL ÷ price tokens on a barely-moved curve.
    const expected = ((lamportsIn * 95n) / 100n) * price.den / price.num;
    console.log(`      curve price ${Number(price.num) / Number(price.den)} lamports/raw; bought ${received}, expected ≈${expected}`);
    expect(Number(received)).to.be.closeTo(Number(expected), Number(expected) * 0.05);
  });

  it("takes the 5% fee in SOL on a buy: 4% to the partner, 1% to Meteora", async () => {
    const before = await readDbcPool(dbc, pool);
    await curveSwap(connection, dbc, buyer, pool, SOL, false, 100);
    const after = await readDbcPool(dbc, pool);
    const partner = after.partnerQuoteFee - before.partnerQuoteFee;
    const protocol = after.protocolQuoteFee - before.protocolQuoteFee;
    console.log(`      1 SOL buy: partner ${partner} lamports, protocol ${protocol} lamports`);
    expect(Number(partner + protocol)).to.be.closeTo(50_000_000, 2);
    expect(Number(partner)).to.be.closeTo(40_000_000, 2);
    expect(after.partnerBaseFee).to.equal(0n);
  });

  it("doesn't tax wallet transfers, and takes the fee in SOL on a sell", async () => {
    const bought = await tokenBalance(buyer.publicKey);
    const half = bought / 2n;
    const holderAta = getAssociatedTokenAddressSync(baseMint, holder.publicKey);
    await sendTransaction(
      connection,
      [
        createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, holderAta, holder.publicKey, baseMint),
        createTransferInstruction(getAssociatedTokenAddressSync(baseMint, buyer.publicKey), holderAta, buyer.publicKey, half),
      ],
      buyer
    );
    expect(await tokenBalance(holder.publicKey)).to.equal(half);

    const before = await readDbcPool(dbc, pool);
    await curveSwap(connection, dbc, holder, pool, half, true, 100);
    const after = await readDbcPool(dbc, pool);
    const partner = after.partnerQuoteFee - before.partnerQuoteFee;
    const protocol = after.protocolQuoteFee - before.protocolQuoteFee;
    expect(partner > 0n).to.be.true;
    expect(Number(partner)).to.be.closeTo(Number(protocol) * 4, 4);
    expect(after.partnerBaseFee).to.equal(0n);
  });

  it("lets the keeper claim the curve's SOL fees", async () => {
    const before = await readDbcPool(dbc, pool);
    const keeperBefore = await balance(keeper.publicKey);
    const { claimedLamports } = await claimCurveFees(connection, dbc, keeper, pool);
    expect(claimedLamports).to.equal(before.partnerQuoteFee);
    expect((await readDbcPool(dbc, pool)).partnerQuoteFee).to.equal(0n);
    // The SOL arrives unwrapped; the claim also opens the keeper's coin token account, whose rent isn't refunded.
    const received = (await balance(keeper.publicKey)) - keeperBefore;
    console.log(`      claimed ${claimedLamports} lamports, keeper balance +${received}`);
    expect(received > claimedLamports - (await tokenAccountRent()) - 20_000n).to.be.true;
  });

  it("halts swaps once 85 SOL is reached, until the migrator migrates the pool", async () => {
    const view = await readDbcPool(dbc, pool);
    const remaining = view.migrationQuoteThreshold - view.quoteReserve;
    const fill = await dbc.pool.swap2({
      owner: buyer.publicKey,
      pool,
      swapBaseForQuote: false,
      referralTokenAccount: null,
      swapMode: SwapMode.PartialFill,
      amountIn: new BN(((remaining * 110n) / 100n).toString()),
      minimumAmountOut: new BN(0),
    });
    await sendTransaction(connection, fill, buyer);
    expect((await readDbcPool(dbc, pool)).phase).to.equal("AWAITING_MIGRATION");

    const blocked = await dbc.pool.swap({
      owner: buyer.publicKey,
      pool,
      amountIn: new BN((SOL / 10n).toString()),
      minimumAmountOut: new BN(0),
      swapBaseForQuote: false,
      referralTokenAccount: null,
    });
    await expectFail(sendTransaction(connection, blocked, buyer), /PoolIsCompleted|0x177d/);

    const result = await migrateIfReady(connection, dbc, migrator, pool);
    expect(result.status).to.equal("migrated");
    if (result.status === "migrated") dammPool = result.dammPool;
    expect((await readDbcPool(dbc, pool)).phase).to.equal("GRADUATED");
    expect((await migrateIfReady(connection, dbc, migrator, pool)).status).to.equal("graduated");
  });

  it("migrates into a DAMM v2 pool charging 5% in SOL, with the keeper holding a fully locked position", async () => {
    const view = await readDammPool(connection, cpAmm, dammPool);
    const fees = await cpAmm.fetchPoolFees(dammPool);
    console.log(`      DAMM v2 ${dammPool.toBase58()}: collectFeeMode ${view.state.collectFeeMode}, fee numerator ${fees?.cliffFeeNumerator.toString()}, SOL depth ${view.quoteDepthLamports}`);
    expect(view.quoteIsB).to.be.true;
    expect(view.state.collectFeeMode).to.equal(1); // OnlyB: fees in SOL
    expect(fees?.cliffFeeNumerator.toString()).to.equal("50000000");

    const all = await cpAmm.getPositionsByUser(keeper.publicKey);
    for (const p of all) {
      console.log(`      keeper position ${p.position.toBase58()}: locked ${p.positionState.permanentLockedLiquidity}, unlocked ${p.positionState.unlockedLiquidity}`);
    }
    const locked = await findLockedPosition(cpAmm, dammPool, keeper.publicKey);
    expect(locked.state.unlockedLiquidity.isZero()).to.be.true;
    expect(locked.state.vestedLiquidity.isZero()).to.be.true;
  });

  it("charges DAMM v2 trades in SOL and lets the keeper claim those fees", async () => {
    let view = await readDammPool(connection, cpAmm, dammPool);
    await dammSwap(connection, cpAmm, buyer, view, NATIVE_MINT, 2n * SOL, 100);
    view = await readDammPool(connection, cpAmm, dammPool);
    await dammSwap(connection, cpAmm, buyer, view, baseMint, (await tokenBalance(buyer.publicKey)) / 4n, 100);

    view = await readDammPool(connection, cpAmm, dammPool);
    const position = await findLockedPosition(cpAmm, dammPool, keeper.publicKey);
    const unclaimed = unclaimedPositionFees(view, position);
    console.log(`      unclaimed position fees: ${unclaimed.quoteLamports} lamports, ${unclaimed.base} base`);
    expect(unclaimed.base).to.equal(0n);
    expect(unclaimed.quoteLamports > 0n).to.be.true;

    const keeperBefore = await balance(keeper.publicKey);
    const claimed = await claimPositionFees(connection, cpAmm, keeper, view, position);
    expect(claimed.quoteLamports).to.equal(unclaimed.quoteLamports);
    const received = (await balance(keeper.publicKey)) - keeperBefore;
    console.log(`      claimed ${claimed.quoteLamports} lamports, keeper balance +${received}`);
    expect(received > claimed.quoteLamports - (await tokenAccountRent()) - 50_000n).to.be.true;
  });

  it("adds and permanently locks liquidity while the pool is thin", async () => {
    const view = await readDammPool(connection, cpAmm, dammPool);
    const decision = decideLiquidity({
      phase: "GRADUATED",
      bucketLamports: SOL,
      poolQuoteDepthLamports: view.quoteDepthLamports,
      targetDepthLamports: 170n * SOL,
      minAddLamports: SOL / 20n,
    });
    expect(decision.addLamports).to.equal(SOL);

    const before = await findLockedPosition(cpAmm, dammPool, keeper.publicKey);
    const { liquidityDelta, signature } = await addLiquidityAndLock(connection, cpAmm, keeper, view, before, decision.addLamports, 100);
    const after = await findLockedPosition(cpAmm, dammPool, keeper.publicKey);
    const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    console.log(`      swap+add+lock: ${tx?.transaction.message.serialize().length} byte message, ${tx?.meta?.computeUnitsConsumed} CU, liquidity +${liquidityDelta}`);
    expect(after.state.permanentLockedLiquidity.sub(before.state.permanentLockedLiquidity).eq(liquidityDelta)).to.be.true;
    expect(after.state.unlockedLiquidity.isZero()).to.be.true;
  });

  it("runs the whole keeper unattended: fees fill the buckets, revenue and buybacks go out, liquidity locks, and a round pays holders", async () => {
    const platformWallet = Keypair.generate();
    const eligible = Keypair.generate();
    const tooSmall = Keypair.generate();

    // Real trading volume on the graduated pool, so there are real fees to claim.
    for (let i = 0; i < 3; i++) {
      let view = await readDammPool(connection, cpAmm, dammPool);
      await dammSwap(connection, cpAmm, buyer, view, NATIVE_MINT, 10n * SOL, 300);
      view = await readDammPool(connection, cpAmm, dammPool);
      await dammSwap(connection, cpAmm, buyer, view, baseMint, (await tokenBalance(buyer.publicKey)) / 10n, 300);
    }

    // Two new holders worth ~1 SOL (eligible at Pyth's price) and ~0.05 SOL (not).
    const price = await new LaunchPriceSource(dbc, cpAmm, pool).poolPrice();
    const tokensWorth = (lamports: bigint) => (lamports * price.den) / price.num;
    for (const [holderKey, lamports] of [[eligible, SOL], [tooSmall, SOL / 20n]] as const) {
      const ata = getAssociatedTokenAddressSync(baseMint, holderKey.publicKey);
      await sendTransaction(
        connection,
        [
          createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, ata, holderKey.publicKey, baseMint),
          createTransferInstruction(getAssociatedTokenAddressSync(baseMint, buyer.publicKey), ata, buyer.publicKey, tokensWorth(lamports)),
        ],
        buyer
      );
    }

    // Basket stand-ins: Jupiter can't run on a fork, so "buying" is the keeper paying lamports for freshly minted local coins.
    const coins = [
      await createMint(connection, payer, payer.publicKey, null, 6, undefined, { commitment: "confirmed" }),
      await createMint(connection, payer, payer.publicKey, null, 6, undefined, { commitment: "confirmed" }),
    ];
    const basket: BasketSource = {
      select: async () => coins.map((mint) => ({ mint, tokenProgram: TOKEN_PROGRAM_ID })),
      swap: async (candidate, wallet, lamports) => {
        const account = getAssociatedTokenAddressSync(candidate.mint, wallet.publicKey);
        const signature = await sendTransaction(
          connection,
          [
            createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, account, wallet.publicKey, candidate.mint),
            SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: payer.publicKey, lamports }),
            createMintToInstruction(candidate.mint, account, payer.publicKey, lamports / 1_000n),
          ],
          payer,
          [wallet]
        );
        return { signature };
      },
    };

    const store = new KeeperStore(fs.mkdtempSync(path.join(os.tmpdir(), "stonkfolio-fork-keeper-")));
    const publishDir = fs.mkdtempSync(path.join(os.tmpdir(), "stonkfolio-fork-published-"));
    const client = DistributorClient.forIndexMint(connection, keeper, baseMint);
    const engine = new RoundEngine({
      connection,
      keeper,
      client,
      indexMint: baseMint,
      holders: new RpcProgramAccountsSource(connection),
      price: new LaunchPriceSource(dbc, cpAmm, pool),
      basket,
      publisher: new LocalDirectoryPublisher(publishDir, client.distributor.toBase58()),
      store,
      policy: {
        version: 1,
        samplesPerRound: 2,
        minWindowSecs: 2,
        seedSlotOffset: 4,
        minEligibleUsdMicro: 50_000_000n,
        maxLeavesPerAsset: 65_536,
        maxMinLeafPasses: 3,
        minLeafValueLamports: 0n,
        autoPushMinRentMultiple: 3,
        excludeOffCurveOwners: true,
        staticExclusions: [],
        // The real Pyth account, cloned into the fork: frozen at clone time, so any age passes.
        priceFeedAccount: PYTH_SOL_USD_PRICE_ACCOUNT.toBase58(),
        priceFeedIdHex: PYTH_SOL_USD_FEED_ID,
        maxPriceAgeSecs: 10 ** 9,
        maxPriceConfBps: 10_000,
        minExpirySecs: 0,
        roundExpirySecs: 3_600,
      },
      params: {
        meanSnapshotIntervalSecs: 1,
        maxWindowSecs: 3_600,
        roundCostMaxBps: 500,
        expectedBasketSize: coins.length,
        priorityFeeLamportsPerTx: 0n,
        swapImpactBps: 100,
        swapOverheadLamports: 10_000_000n,
        maxBuyAttempts: 2,
        maxBuyPhaseSecs: 600,
        maxTransferFeeBps: 300,
        maxActivationAttempts: 3,
        maxPushesPerStep: 25,
        maxPushAttempts: 3,
      },
      now: () => Math.floor(Date.now() / 1000),
    });
    const logs: string[] = [];
    const coinKeeper = new CoinKeeper({
      connection,
      keeper,
      dbc,
      cpAmm,
      pool,
      platformTokenPool: pool, // this coin is $STONKFOLIO itself
      store,
      engine,
      shares: { basketBps: 7_000, coinBuybackBps: 500, liquidityBps: 500, platformBuybackBps: 1_000, platformRevenueBps: 1_000 },
      platformRevenueAddress: platformWallet.publicKey,
      thresholds: {
        minFeeClaimLamports: SOL / 100n,
        minBuybackLamports: SOL / 100n,
        minPlatformPayoutLamports: SOL / 100n,
        liquidityTargetLamports: 170n * SOL,
        minLiquidityAddLamports: SOL / 100n,
        slippageBps: 300,
        maxRoundStepsPerTick: 50,
        maxTickMs: 120_000,
      },
      log: (message) => {
        logs.push(message);
        console.log(`      [keeper] ${message}`);
      },
    });

    const supplyBefore = (await getMint(connection, baseMint)).supply;
    const lockedBefore = (await findLockedPosition(cpAmm, dammPool, keeper.publicKey)).state.permanentLockedLiquidity;

    // The first round is finished once it's committed (tracked for expiry) and every payout has been pushed;
    // the keeper opens the next window at commit.
    const firstRoundDone = () => {
      const s = store.load();
      return s.expiring.length === 1 && s.paying.length === 0;
    };
    for (let i = 0; i < 400 && !firstRoundDone(); i++) {
      await coinKeeper.tick();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(firstRoundDone(), "the first round should have finished").to.be.true;
    const state = store.load();

    expect(logs.some((l) => l.startsWith("claimed "))).to.be.true;
    expect(await balance(platformWallet.publicKey) > 0n, "platform revenue was paid").to.be.true;
    expect((await getMint(connection, baseMint)).supply < supplyBefore, "buybacks burned supply").to.be.true;
    const lockedAfter = (await findLockedPosition(cpAmm, dammPool, keeper.publicKey)).state.permanentLockedLiquidity;
    expect(lockedAfter.gt(lockedBefore), "liquidity was added and locked").to.be.true;

    const roundId = state.expiring[0].roundId;
    const bundle = store.bundleDir(roundId);
    const report = verifyRoundArtifacts(bundle);
    const header = await connection.getAccountInfo(client.round(roundId));
    expect(readCommittedRoundHashes(header!.data)).to.deep.equal({ assetsRoot: report.assetsRoot, artifactHash: report.manifestHash });
    await verifyRoundOnChain(connection, report);

    const { files } = readArtifacts(bundle);
    const inputs = parseRoundInputs(files.get("inputs.json")!);
    // SOL/USD was read on-chain from the real Pyth account when the window closed.
    expect(inputs.intent.solUsd.price > 0n).to.be.true;
    const prepared = prepareRound(inputs);
    const recipients = new Set(prepared.allocation.assets.flatMap((a) => a.leaves.map((l) => l.recipient)));
    expect(recipients.has(eligible.publicKey.toBase58())).to.be.true;
    expect(recipients.has(tooSmall.publicKey.toBase58())).to.be.false;
    expect(recipients.has(keeper.publicKey.toBase58())).to.be.false;
    for (const allocation of prepared.allocation.assets) {
      const account = await client.fetchRoundAsset(roundId, allocation.assetIdx);
      for (const leaf of allocation.leaves) {
        expect(isLeafClaimed(Buffer.from(account!.bitmap), leaf.leafIdx)).to.be.true;
        const ata = getAssociatedTokenAddressSync(new PublicKey(allocation.mint), new PublicKey(leaf.recipient));
        expect((await getAccount(connection, ata, "confirmed")).amount).to.equal(leaf.amount);
      }
    }
    console.log(`      round ${roundId}: ${recipients.size} recipient(s), SOL/USD ${toMicroUsd(inputs.intent.solUsd.price, inputs.intent.solUsd.exponent)} micro-USD`);
  });
});
