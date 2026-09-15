/**
 * Autonomous payout rounds end to end against the real distributor program:
 * the round engine runs unattended from open to every payout, survives a
 * restart mid-round, leaves an undeliverable payout for self-claim, rolls
 * expired leftovers into the next round, keeps each coin's basket inventory
 * apart, skips a coin that can't be bought, and leaves small first-time
 * payouts for self-claim. Needs the distributor validator
 * (`bash scripts/distributor-test-validator.sh`), then `npm run test:distributor`.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  calculateEpochFee,
  createAccount,
  createAssociatedTokenAccountIdempotentInstruction,
  createEnableRequiredMemoTransfersInstruction,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createMint,
  createMintToInstruction,
  createReallocateInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getMintLen,
  getOrCreateAssociatedTokenAccount,
  getTransferFeeConfig,
  mintTo,
} from "@solana/spl-token";
import { readArtifacts } from "../lib/artifacts";
import { PYTH_SOL_USD_FEED_ID } from "../lib/pyth";
import { sendTransaction } from "../lib/send";
import { DistributorClient, isLeafClaimed } from "../keeper/distributor/client";
import { RpcProgramAccountsSource } from "../keeper/holders/source";
import { BasketCandidate, BasketSource, RoundEngine, RoundParams } from "../keeper/round/engine";
import { RoundPolicy } from "../keeper/round/policy";
import { AssetAllocation } from "../keeper/round/types";
import { parseRoundInputs, prepareRound } from "../keeper/round/prepare";
import { LocalDirectoryPublisher } from "../keeper/round/publisher";
import { readCommittedRoundHashes, verifyRoundArtifacts, verifyRoundOnChain } from "../keeper/round/verify";
import { KeeperState, KeeperStore, PayoutFailure } from "../keeper/state";
import { TEST_PRICE_ACCOUNTS } from "../scripts/make-test-price-accounts";

const RPC_URL = process.env.DISTRIBUTOR_TEST_RPC ?? "http://127.0.0.1:8899";
const SOL = 1_000_000_000n;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("autonomous payout rounds", function () {
  this.timeout(1_800_000);

  const connection = new Connection(RPC_URL, "confirmed");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(process.cwd(), ".keys/test-upgrade-authority.json"), "utf-8")))
  );
  const keeper = Keypair.generate();
  const holders = { a: Keypair.generate(), b: Keypair.generate(), c: Keypair.generate(), d: Keypair.generate(), e: Keypair.generate(), memo: Keypair.generate() };
  const publishDir = fs.mkdtempSync(path.join(os.tmpdir(), "stonkfolio-published-"));
  const store = new KeeperStore(fs.mkdtempSync(path.join(os.tmpdir(), "stonkfolio-keeper-")));
  let indexMint: PublicKey;
  let plainCoin: PublicKey;
  let feeCoin: PublicKey;
  const firstRoundId = 0n;

  // SOL/USD comes from the validator's test Pyth account: $100.
  const policy: RoundPolicy = {
    version: 1,
    samplesPerRound: 3,
    minWindowSecs: 2,
    seedSlotOffset: 4,
    minEligibleUsdMicro: 50_000_000n,
    maxLeavesPerAsset: 65_536,
    maxMinLeafPasses: 3,
    minLeafValueLamports: 0n,
    autoPushMinRentMultiple: 3,
    excludeOffCurveOwners: true,
    staticExclusions: [],
    priceFeedAccount: TEST_PRICE_ACCOUNTS.fresh.toBase58(),
    priceFeedIdHex: PYTH_SOL_USD_FEED_ID,
    maxPriceAgeSecs: 30 * 24 * 60 * 60,
    maxPriceConfBps: 100,
    minExpirySecs: 0,
    roundExpirySecs: 60,
  };

  const params: RoundParams = {
    meanSnapshotIntervalSecs: 3,
    maxWindowSecs: 3_600,
    roundCostMaxBps: 500,
    expectedBasketSize: 2,
    priorityFeeLamportsPerTx: 0n,
    swapImpactBps: 100,
    swapOverheadLamports: 10_000_000n,
    maxBuyAttempts: 2,
    maxBuyPhaseSecs: 600,
    maxTransferFeeBps: 300,
    maxActivationAttempts: 3,
    maxPushesPerStep: 20,
    maxPushAttempts: 3,
  };

  /** Stands in for Jupiter: the swap wallet pays the lamports and receives 1 raw unit per 1,000, in one transaction. */
  async function standInSwap(candidate: BasketCandidate, wallet: Keypair, lamports: bigint) {
    const account = getAssociatedTokenAddressSync(candidate.mint, wallet.publicKey, false, candidate.tokenProgram);
    const signature = await sendTransaction(
      connection,
      [
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, account, wallet.publicKey, candidate.mint, candidate.tokenProgram),
        SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: payer.publicKey, lamports }),
        createMintToInstruction(candidate.mint, account, payer.publicKey, lamports / 1_000n, [], candidate.tokenProgram),
      ],
      payer,
      [wallet]
    );
    return { signature };
  }

  function engineFor(target: { store: KeeperStore; indexMint: PublicKey; basket: BasketSource; policy: RoundPolicy; params: RoundParams }): RoundEngine {
    const client = DistributorClient.forIndexMint(connection, keeper, target.indexMint);
    return new RoundEngine({
      connection,
      keeper,
      client,
      indexMint: target.indexMint,
      holders: new RpcProgramAccountsSource(connection),
      price: { poolPrice: async () => ({ num: 1n, den: 1n }) }, // 1 lamport per raw unit
      basket: target.basket,
      publisher: new LocalDirectoryPublisher(publishDir, client.distributor.toBase58()),
      store: target.store,
      policy: target.policy,
      params: target.params,
      now: () => Math.floor(Date.now() / 1000),
    });
  }

  const coinOne = () =>
    engineFor({
      store,
      indexMint,
      basket: {
        select: async () => [
          { mint: plainCoin, tokenProgram: TOKEN_PROGRAM_ID },
          { mint: feeCoin, tokenProgram: TOKEN_2022_PROGRAM_ID },
        ],
        swap: standInSwap,
      },
      policy,
      params,
    });

  async function runUntil(target: KeeperStore, engine: RoundEngine, done: (state: KeeperState) => boolean, label: string): Promise<void> {
    for (let i = 0; i < 3_000; i++) {
      if (done(target.load())) return;
      let report: string;
      try {
        report = await engine.step();
      } catch (err) {
        // The production loop logs and retries too; a genuinely stuck step fails the step budget.
        report = `error: ${err instanceof Error ? err.message.split("\n")[0] : err}`;
      }
      if (!/^(collecting|waiting)/.test(report)) console.log(`      [${label}] ${report}`);
      if (/^(collecting|waiting|error)/.test(report)) await sleep(500);
    }
    throw new Error(`${label} did not finish`);
  }

  function creditPot(target: KeeperStore, lamports: bigint): void {
    const state = target.load();
    state.ledger.basketLamports += lamports;
    target.save(state);
  }

  function loadBundle(target: KeeperStore, roundId: bigint) {
    const bundle = target.bundleDir(roundId);
    const { files } = readArtifacts(bundle);
    return { bundle, prepared: prepareRound(parseRoundInputs(files.get("inputs.json")!)) };
  }

  function failuresOf(target: KeeperStore, roundId: bigint): PayoutFailure[] {
    return JSON.parse(fs.readFileSync(path.join(target.roundDir(roundId), "payout-failures.json"), "utf-8"));
  }

  async function balanceOf(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey): Promise<bigint> {
    try {
      return (await getAccount(connection, getAssociatedTokenAddressSync(mint, owner, false, tokenProgram), "confirmed", tokenProgram)).amount;
    } catch {
      return 0n;
    }
  }

  async function net(mint: PublicKey, gross: bigint): Promise<bigint> {
    const config = getTransferFeeConfig(await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID))!;
    const { epoch } = await connection.getEpochInfo("confirmed");
    return gross - calculateEpochFee(config, BigInt(epoch), gross);
  }

  const legacyMint = () => createMint(connection, payer, payer.publicKey, null, 6, undefined, { commitment: "confirmed" });

  /** Index coin holders at 1 lamport per raw unit and $100/SOL: $300, $200, $100, exactly $50, $10, $100. */
  async function mintIndexCoin(): Promise<PublicKey> {
    const mint = await legacyMint();
    const balances: [Keypair, bigint][] = [
      [holders.a, 3n * SOL],
      [holders.b, 2n * SOL],
      [holders.c, SOL],
      [holders.d, SOL / 2n],
      [holders.e, SOL / 10n],
      [holders.memo, SOL],
    ];
    for (const [holder, amount] of balances) {
      const account = await getOrCreateAssociatedTokenAccount(connection, payer, mint, holder.publicKey, false, "confirmed", { commitment: "confirmed" });
      await mintTo(connection, payer, mint, account.address, payer, amount, [], { commitment: "confirmed" });
    }
    return mint;
  }

  before(async () => {
    await sendTransaction(
      connection,
      [
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: keeper.publicKey, lamports: 50 * 1e9 }),
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: holders.memo.publicKey, lamports: 20 * 1e9 }),
      ],
      payer
    );
    indexMint = await mintIndexCoin();
    plainCoin = await legacyMint();

    const feeMint = Keypair.generate();
    const space = getMintLen([ExtensionType.TransferFeeConfig]);
    await sendTransaction(
      connection,
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: feeMint.publicKey,
          space,
          lamports: await connection.getMinimumBalanceForRentExemption(space),
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        // No fee config authority: the distributor refuses mints whose fee could be raised later.
        createInitializeTransferFeeConfigInstruction(feeMint.publicKey, null, payer.publicKey, 100, 1_000_000_000n, TOKEN_2022_PROGRAM_ID),
        createInitializeMintInstruction(feeMint.publicKey, 6, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
      ],
      payer,
      [feeMint]
    );
    feeCoin = feeMint.publicKey;

    // The memo holder's account for the fee coin requires memos, so a push can never land there.
    const memoAta = getAssociatedTokenAddressSync(feeCoin, holders.memo.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await sendTransaction(
      connection,
      [
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, memoAta, holders.memo.publicKey, feeCoin, TOKEN_2022_PROGRAM_ID),
        createReallocateInstruction(memoAta, payer.publicKey, [ExtensionType.MemoTransfer], holders.memo.publicKey, [], TOKEN_2022_PROGRAM_ID),
        createEnableRequiredMemoTransfersInstruction(memoAta, holders.memo.publicKey, [], TOKEN_2022_PROGRAM_ID),
      ],
      payer,
      [holders.memo]
    );
  });

  it("runs a round unattended, survives a restart mid-round, and pays every deliverable payout exactly once", async () => {
    creditPot(store, 10n * SOL);
    await runUntil(store, coinOne(), (s) => s.paying.length === 1, "keeper A");
    // "Crash": a brand-new keeper process picks up from the state file alone.
    await runUntil(store, coinOne(), (s) => s.paying.length === 0 && (s.round?.roundId ?? 0n) > firstRoundId, "keeper B");

    const { bundle, prepared } = loadBundle(store, firstRoundId);
    const report = verifyRoundArtifacts(bundle);
    const client = DistributorClient.forIndexMint(connection, keeper, indexMint);
    const header = await connection.getAccountInfo(client.round(firstRoundId));
    expect(readCommittedRoundHashes(header!.data)).to.deep.equal({ assetsRoot: report.assetsRoot, artifactHash: report.manifestHash });
    const notes = await verifyRoundOnChain(connection, report);
    expect(notes.filter((n) => /keeper is now/.test(n))).to.deep.equal([]);
    expect(report.inputs.purchases).to.have.length(2);
    expect(report.inputs.purchases.every((p) => p.buyer !== keeper.publicKey.toBase58()), "buys run from throwaway wallets").to.be.true;
    expect(fs.existsSync(path.join(publishDir, client.distributor.toBase58(), firstRoundId.toString(), "manifest.json"))).to.be.true;
    expect(fs.existsSync(store.snapshotDir(firstRoundId)), "raw snapshots are removed once the round commits").to.be.false;

    const recipients = new Set(prepared.allocation.assets.flatMap((a) => a.leaves.map((l) => l.recipient)));
    expect(recipients.has(holders.d.publicKey.toBase58()), "exactly $50 qualifies").to.be.true;
    expect(recipients.has(holders.e.publicKey.toBase58()), "$10 does not").to.be.false;
    expect(recipients.has(keeper.publicKey.toBase58())).to.be.false;

    const failures = failuresOf(store, firstRoundId);
    expect(failures).to.have.length(1);
    expect(failures[0].recipient).to.equal(holders.memo.publicKey.toBase58());
    expect(failures[0].permanent).to.be.true;
    expect(failures[0].reason).to.match(/memo/i);

    for (const allocation of prepared.allocation.assets as AssetAllocation[]) {
      const mint = new PublicKey(allocation.mint);
      const tokenProgram = new PublicKey(allocation.tokenProgram);
      const account = await client.fetchRoundAsset(firstRoundId, allocation.assetIdx);
      const bitmap = Buffer.from(account!.bitmap);
      for (const leaf of allocation.leaves) {
        const undeliverable = mint.equals(feeCoin) && leaf.recipient === holders.memo.publicKey.toBase58();
        expect(isLeafClaimed(bitmap, leaf.leafIdx), `${leaf.recipient} on ${allocation.mint}`).to.equal(!undeliverable);
        if (undeliverable) continue;
        const expected = mint.equals(feeCoin) ? await net(mint, leaf.amount) : leaf.amount;
        expect(await balanceOf(mint, new PublicKey(leaf.recipient), tokenProgram)).to.equal(expected);
      }
    }

    const state = store.load();
    expect(state.ledger.operationsLamports, "the round's cost reserve is settled when it finishes").to.equal(0n);
  });

  it("returns an expired round's unclaimed payout to the coin's inventory, pays it in the next round, and lets the holder self-claim", async () => {
    // The next window opened at commit; let the first round expire and close before funding it.
    await runUntil(store, coinOne(), (s) => s.expiring.every((r) => r.roundId !== firstRoundId), "keeper C (expiry)");
    const client = DistributorClient.forIndexMint(connection, keeper, indexMint);
    expect(await client.fetchRoundAsset(firstRoundId, 0)).to.equal(null);
    expect((store.load().inventory[feeCoin.toBase58()]?.amount ?? 0n) > 0n, "the memo holder's unclaimed payout is back in inventory").to.be.true;

    creditPot(store, 10n * SOL);
    const secondRoundId = firstRoundId + 1n;
    await runUntil(store, coinOne(), (s) => s.paying.length === 0 && (s.round?.roundId ?? 0n) > secondRoundId, "keeper C");

    const { prepared } = loadBundle(store, secondRoundId);
    const feeAsset = prepared.allocation.assets.find((a) => new PublicKey(a.mint).equals(feeCoin))!;
    const purchase = prepared.inputs.purchases.find((p) => new PublicKey(p.mint).equals(feeCoin))!;
    expect(feeAsset.allocatable > (await net(feeCoin, await net(feeCoin, purchase.received))), "includes the first round's returned payout").to.be.true;

    const leaf = feeAsset.leaves.find((l) => l.recipient === holders.memo.publicKey.toBase58())!;
    const tree = prepared.trees.assets[feeAsset.assetIdx];
    const side = await createAccount(connection, holders.memo, feeCoin, holders.memo.publicKey, Keypair.generate(), { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    const claimClient = new DistributorClient(connection, holders.memo, client.distributor);
    await sendTransaction(connection, [await claimClient.selfClaimInstruction(secondRoundId, tree, leaf, side)], holders.memo);
    expect((await getAccount(connection, side, "confirmed", TOKEN_2022_PROGRAM_ID)).amount).to.equal(await net(feeCoin, leaf.amount));
  });

  it("keeps a second coin's basket inventory apart, skips a coin it can't buy, leaves small first-time payouts for self-claim, and opens the next window at commit", async () => {
    const secondIndex = await mintIndexCoin();
    const rareCoin = await legacyMint();
    const brokenCoin = await legacyMint();
    const secondStore = new KeeperStore(fs.mkdtempSync(path.join(os.tmpdir(), "stonkfolio-keeper-2-")));
    const coinOneInventoryBefore = store.load().inventory[plainCoin.toBase58()]?.amount ?? 0n;
    const coinTwo = () =>
      engineFor({
        store: secondStore,
        indexMint: secondIndex,
        basket: {
          select: async () => [plainCoin, rareCoin, brokenCoin].map((mint) => ({ mint, tokenProgram: TOKEN_PROGRAM_ID })),
          swap: async (candidate, wallet, lamports) => {
            if (candidate.mint.equals(brokenCoin)) throw new Error("no route for this coin");
            return standInSwap(candidate, wallet, lamports);
          },
        },
        policy: { ...policy, roundExpirySecs: 3_600 },
        params: { ...params, roundCostMaxBps: 10_000, expectedBasketSize: 3 },
      });

    // A small pot: after round costs each coin gets ~0.033 SOL, so the $50 holder's rare-coin payout
    // is worth ~0.002 SOL — under 3x a token account's rent — while the $300 holder's is ~0.013 SOL.
    creditPot(secondStore, (15n * SOL) / 100n);
    await runUntil(secondStore, coinTwo(), (s) => s.paying.length === 1 && s.round?.status === "OPEN", "coin 2 A");
    await runUntil(secondStore, coinTwo(), (s) => s.paying.length === 0, "coin 2 B");

    const report = verifyRoundArtifacts(secondStore.bundleDir(0n));
    await verifyRoundOnChain(connection, report);
    const { inputs, prepared } = report;
    expect(inputs.purchases.map((p) => p.mint).sort()).to.deep.equal([plainCoin, rareCoin].map((m) => m.toBase58()).sort());
    expect(inputs.assets.map((a) => a.mint)).to.not.include(brokenCoin.toBase58());

    // Coin 2 funded its shared-mint asset only from its own purchase; coin 1's holdings are untouched.
    const plainPurchase = inputs.purchases.find((p) => p.mint === plainCoin.toBase58())!;
    expect(inputs.assets.find((a) => a.mint === plainCoin.toBase58())!.allocatable).to.equal(plainPurchase.received);
    expect(store.load().inventory[plainCoin.toBase58()]?.amount ?? 0n).to.equal(coinOneInventoryBefore);

    const rare = prepared.allocation.assets.find((a) => a.mint === rareCoin.toBase58())!;
    const failures = failuresOf(secondStore, 0n);
    const deferred = failures.find((f) => f.assetIdx === rare.assetIdx && f.recipient === holders.d.publicKey.toBase58());
    expect(deferred?.reason).to.match(/self-claim/);
    expect(await balanceOf(rareCoin, holders.d.publicKey, TOKEN_PROGRAM_ID)).to.equal(0n);
    expect((await balanceOf(rareCoin, holders.a.publicKey, TOKEN_PROGRAM_ID)) > 0n, "the $300 holder's payout is pushed").to.be.true;
    // d already holds the shared coin from coin 1's rounds, so that payout is pushed however small.
    expect(failures.some((f) => f.recipient === holders.d.publicKey.toBase58() && f.assetIdx !== rare.assetIdx)).to.be.false;
  });
});
