/**
 * Unattended devnet rehearsal of the real keeper. A launched devnet coin runs
 * through several payout rounds with no intervention: CoinKeeper claims fees,
 * splits and spends them, and the RoundEngine opens, seeds, buys, commits,
 * activates and pushes each round. Every finished round is checked the way
 * anyone would check it: `verifyRoundArtifacts` plus `verifyRoundOnChain`.
 *
 * Two stand-ins, both because devnet lacks the real thing: a trader wallet
 * makes curve volume so there are fees to claim, and the basket "buys" test
 * coins from a market-maker wallet (Jupiter doesn't run on devnet). Everything
 * else — Meteora, Pyth, the distributor, the swap wallets — is real.
 *
 *   node dist/scripts/devnet-rehearsal.js --deployment <devnet deployment.json> --keeper .keys/keeper-devnet.json
 *     --work <dir> [--rounds 3] [--max-minutes 120] [--rpc https://api.devnet.solana.com]
 *     [--holders-rpc https://api.devnet.solana.com]
 *
 * Holder snapshots need getProgramAccounts, which some RPC plans (e.g. Alchemy's free tier) don't offer;
 * --holders-rpc sends just those calls elsewhere, as mainnet sends them to Helius DAS.
 *
 * Refuses to run anywhere but devnet. Test wallets are kept in <work>/rehearsal.json so a rerun resumes.
 *
 * Soak mode (scripts/devnet-soak.sh): `--until <ms since epoch>` runs until that time instead of for a
 * number of rounds, logs and survives loop errors, prints a HEALTH line every 10 minutes, and returns the
 * stand-ins' SOL to the keeper. `--snapshot-secs` slows the snapshot cadence (not part of the policy hash).
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createMint,
  createMintToInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getMintLen,
} from "@solana/spl-token";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { patchConnectionForPollingConfirmation } from "../lib/confirm";
import { readDeployment } from "../lib/deployment";
import { PYTH_SOL_USD_FEED_ID, PYTH_SOL_USD_PRICE_ACCOUNT } from "../lib/pyth";
import { ProcessLock } from "../lib/lock";
import { sendTransaction } from "../lib/send";
import { CoinKeeper } from "../keeper/coin";
import { DistributorClient, isLeafClaimed } from "../keeper/distributor/client";
import { RpcProgramAccountsSource } from "../keeper/holders/source";
import { curveSwap } from "../keeper/meteora/dbc";
import { LaunchPriceSource } from "../keeper/meteora/price";
import { MeteoraPin, checkMeteora, parseProgramAccount, parseProgramData } from "../keeper/monitor";
import { BasketSource, RoundEngine, RoundParams } from "../keeper/round/engine";
import { RoundPolicy } from "../keeper/round/policy";
import { LocalDirectoryPublisher } from "../keeper/round/publisher";
import { verifyRoundArtifacts, verifyRoundOnChain } from "../keeper/round/verify";
import { KeeperStore, PayoutFailure } from "../keeper/state";
import { loadKeypair, parseArgs, required, run } from "./launch/common";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const METEORA_PROGRAMS: [string, string][] = [
  ["dynamic_bonding_curve", "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"],
  ["damm_v2", "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"],
];
const DAMM_V2_CUSTOMIZABLE_CONFIG = "A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck";
const SOL = 1_000_000_000n;
/** Trade only while the basket pot is below this, so volume stops once a round can fund. */
const POT_TARGET_LAMPORTS = 80_000_000n;
const TRADE_SIZE_LAMPORTS = 600_000_000n;

/** Round rules for the rehearsal: the production policy's shape with short windows and a $5 threshold. */
const POLICY: RoundPolicy = {
  version: 1,
  samplesPerRound: 4,
  minWindowSecs: 60,
  seedSlotOffset: 32,
  minEligibleUsdMicro: 5_000_000n,
  maxLeavesPerAsset: 65_536,
  maxMinLeafPasses: 3,
  minLeafValueLamports: 100_000n,
  autoPushMinRentMultiple: 3,
  excludeOffCurveOwners: true,
  staticExclusions: [{ owner: "1nc1nerator11111111111111111111111111111111", reason: "burn address" }],
  priceFeedAccount: PYTH_SOL_USD_PRICE_ACCOUNT.toBase58(),
  priceFeedIdHex: PYTH_SOL_USD_FEED_ID,
  maxPriceAgeSecs: 900, // devnet's sponsored feed updates less often than mainnet's
  maxPriceConfBps: 200,
  minExpirySecs: 0,
  roundExpirySecs: 600,
};

const PARAMS: RoundParams = {
  meanSnapshotIntervalSecs: 15,
  maxWindowSecs: 3_600,
  roundCostMaxBps: 3_000,
  expectedBasketSize: 2,
  priorityFeeLamportsPerTx: 0n,
  swapImpactBps: 100,
  swapOverheadLamports: 10_000_000n,
  maxBuyAttempts: 3,
  maxBuyPhaseSecs: 900,
  maxTransferFeeBps: 300,
  maxActivationAttempts: 5,
  maxPushesPerStep: 25,
  maxPushAttempts: 5,
};

interface RehearsalFile {
  marketMaker: number[];
  trader: number[];
  holders: number[][];
  revenueWallet: number[];
  basketMints: string[];
  distributed: boolean;
  verifiedRounds: string[];
  /** Platform revenue moved back to the keeper during a soak, so the summary still counts it. */
  revenueRecycledLamports?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const keypairOf = (bytes: number[]) => Keypair.fromSecretKey(Uint8Array.from(bytes));
const sol = (lamports: bigint | number) => (Number(lamports) / 1e9).toFixed(4);
const mb = (bytes: number) => (bytes / 1_048_576).toFixed(1);
const kb = (bytes: number) => Math.round(bytes / 1024);
const firstLine = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : String(err));
const HEALTH_INTERVAL_MS = 10 * 60_000;

/** Ends the run even in soak mode, where every other loop error is logged and survived. */
class Stop extends Error {}

function dirBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    const full = path.join(dir, entry.name);
    return sum + (entry.isDirectory() ? dirBytes(full) : fs.statSync(full).size);
  }, 0);
}

async function tokenBalance(connection: Connection, mint: PublicKey, owner: PublicKey): Promise<bigint> {
  try {
    return (await getAccount(connection, getAssociatedTokenAddressSync(mint, owner), "confirmed")).amount;
  } catch {
    return 0n;
  }
}

/** A StonkFun reward-coin lookalike: Token-2022 with a 3% transfer fee whose authority can still change it. */
async function createFeeMint(connection: Connection, authority: Keypair): Promise<PublicKey> {
  const mint = Keypair.generate();
  const space = getMintLen([ExtensionType.TransferFeeConfig]);
  const lamports = await connection.getMinimumBalanceForRentExemption(space);
  await sendTransaction(
    connection,
    [
      SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: mint.publicKey, space, lamports, programId: TOKEN_2022_PROGRAM_ID }),
      createInitializeTransferFeeConfigInstruction(mint.publicKey, authority.publicKey, authority.publicKey, 300, 1_000_000_000_000_000n, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(mint.publicKey, 6, authority.publicKey, null, TOKEN_2022_PROGRAM_ID),
    ],
    authority,
    [mint]
  );
  return mint.publicKey;
}

async function topUp(connection: Connection, from: Keypair, to: PublicKey, target: bigint): Promise<void> {
  const balance = BigInt(await connection.getBalance(to, "confirmed"));
  if (balance >= target / 2n) return;
  await sendTransaction(connection, [SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: target - balance })], from);
  log(`funded ${to.toBase58()} with ${sol(target - balance)} SOL`);
}

/** Meteora's devnet builds differ from mainnet's, so the rehearsal pins what devnet runs at the start. */
async function devnetPin(connection: Connection): Promise<MeteoraPin> {
  const pin: MeteoraPin = {};
  for (const [name, programId] of METEORA_PROGRAMS) {
    const program = await connection.getAccountInfo(new PublicKey(programId), "confirmed");
    const programData = await connection.getAccountInfo(parseProgramAccount(program!.data), "confirmed");
    const { slot, upgradeAuthority } = parseProgramData(programData!.data);
    pin[name] = { programId, sha256: "not checked by the keeper", lastDeployedSlot: slot, upgradeAuthority };
  }
  const config = await connection.getAccountInfo(new PublicKey(DAMM_V2_CUSTOMIZABLE_CONFIG), "confirmed");
  pin.damm_v2_customizable_config = { address: DAMM_V2_CUSTOMIZABLE_CONFIG, sha256: createHash("sha256").update(config!.data).digest("hex") };
  return pin;
}

run(async () => {
  const args = parseArgs();
  const rpc = args.get("rpc") ?? "https://api.devnet.solana.com";
  const connection = new Connection(rpc, "confirmed");
  patchConnectionForPollingConfirmation(connection);
  if ((await connection.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("--rpc is not devnet; the rehearsal only runs on devnet");
  const holdersConnection = new Connection(args.get("holders-rpc") ?? rpc, "confirmed");
  if ((await holdersConnection.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("--holders-rpc is not devnet; the rehearsal only runs on devnet");

  const keeper = loadKeypair(required(args, "keeper"));
  const deploymentFile = required(args, "deployment");
  const deployment = readDeployment(deploymentFile);
  if (!deployment || deployment.cluster !== "devnet") throw new Error(`${deploymentFile} is not a devnet deployment`);
  if (deployment.feeClaimer !== keeper.publicKey.toBase58()) throw new Error("the keeper key isn't this deployment's fee claimer");
  // The devnet test coin was launched as STONKFOLIO, before mainnet's symbol was set to FOLIO.
  const platformSymbol = args.get("platform-symbol") ?? "STONKFOLIO";
  const entry = deployment.pools.find((p) => p.symbol === platformSymbol);
  if (!entry) throw new Error(`deployment has no ${platformSymbol} pool`);
  const work = required(args, "work");
  const roundsWanted = Number(args.get("rounds") ?? 3);
  const deadline = Date.now() + Number(args.get("max-minutes") ?? 120) * 60_000;
  const soakUntil = args.get("until") !== undefined ? Number(args.get("until")) : undefined;
  const soaking = soakUntil !== undefined;
  if (args.get("snapshot-secs") !== undefined) PARAMS.meanSnapshotIntervalSecs = Number(args.get("snapshot-secs"));
  fs.mkdirSync(work, { recursive: true });

  // --- test wallets and basket coins (created once, then resumed) -------------
  const rehearsalFile = path.join(work, "rehearsal.json");
  const r: RehearsalFile = fs.existsSync(rehearsalFile)
    ? JSON.parse(fs.readFileSync(rehearsalFile, "utf-8"))
    : {
        marketMaker: Array.from(Keypair.generate().secretKey),
        trader: Array.from(Keypair.generate().secretKey),
        holders: Array.from({ length: 4 }, () => Array.from(Keypair.generate().secretKey)),
        revenueWallet: Array.from(Keypair.generate().secretKey),
        basketMints: [],
        distributed: false,
        verifiedRounds: [],
      };
  // Written atomically: the soak kills this process at arbitrary moments.
  const save = () => {
    fs.writeFileSync(`${rehearsalFile}.tmp`, JSON.stringify(r, null, 2), { mode: 0o600 });
    fs.renameSync(`${rehearsalFile}.tmp`, rehearsalFile);
  };
  save();
  const marketMaker = keypairOf(r.marketMaker);
  const trader = keypairOf(r.trader);
  const holders = r.holders.map(keypairOf);
  const revenueWallet = keypairOf(r.revenueWallet).publicKey;

  await topUp(connection, keeper, marketMaker.publicKey, SOL / 20n);
  await topUp(connection, keeper, trader.publicKey, (3n * SOL) / 2n);
  // One plain coin and one shaped like StonkFun's reward coins (3% transfer fee, fee authority kept).
  while (r.basketMints.length < 2) {
    const feeCoin = r.basketMints.length === 1;
    const mint = feeCoin
      ? await createFeeMint(connection, marketMaker)
      : await createMint(connection, marketMaker, marketMaker.publicKey, null, 6, undefined, { commitment: "confirmed" });
    r.basketMints.push(mint.toBase58());
    save();
    log(`created basket test coin ${mint.toBase58()}${feeCoin ? " (Token-2022, 3% transfer fee, fee authority kept)" : ""}`);
  }

  const pool = new PublicKey(entry.pool);
  const indexMint = new PublicKey(entry.baseMint);
  const dbc = DynamicBondingCurveClient.create(connection, "confirmed");
  const cpAmm = new CpAmm(connection);
  const store = new KeeperStore(path.join(work, "state"));
  const client = DistributorClient.forIndexMint(connection, keeper, indexMint);
  // The same lock the keeper service holds; after a hard kill the next run must take over the stale one.
  const lock = ProcessLock.acquire(store.dir);

  // Stands in for Jupiter: the swap wallet pays the market maker, which mints 1 raw unit per 1,000 lamports.
  const basket: BasketSource = {
    select: async () =>
      Promise.all(
        r.basketMints.map(async (mint) => {
          const info = await connection.getAccountInfo(new PublicKey(mint), "confirmed");
          if (!info) throw new Error(`basket test coin ${mint} not found`);
          return { mint: new PublicKey(mint), tokenProgram: info.owner };
        })
      ),
    swap: async (candidate, wallet, lamports) => {
      const account = getAssociatedTokenAddressSync(candidate.mint, wallet.publicKey, false, candidate.tokenProgram);
      const signature = await sendTransaction(
        connection,
        [
          createAssociatedTokenAccountIdempotentInstruction(marketMaker.publicKey, account, wallet.publicKey, candidate.mint, candidate.tokenProgram),
          SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: marketMaker.publicKey, lamports }),
          createMintToInstruction(candidate.mint, account, marketMaker.publicKey, lamports / 1_000n, [], candidate.tokenProgram),
        ],
        marketMaker,
        [wallet]
      );
      return { signature };
    },
  };

  const engine = new RoundEngine({
    connection,
    keeper,
    client,
    indexMint,
    holders: new RpcProgramAccountsSource(holdersConnection),
    price: new LaunchPriceSource(dbc, cpAmm, pool),
    basket,
    publisher: new LocalDirectoryPublisher(path.join(work, "artifacts"), client.distributor.toBase58()),
    store,
    policy: POLICY,
    params: PARAMS,
    now: () => Math.floor(Date.now() / 1000),
  });
  const coin = new CoinKeeper({
    connection,
    keeper,
    dbc,
    cpAmm,
    pool,
    platformTokenPool: pool,
    store,
    engine,
    shares: { basketBps: 7_000, flywheelBps: 500, platformBuybackBps: 1_000, platformRevenueBps: 1_500 },
    platformRevenueAddress: revenueWallet,
    thresholds: {
      minFeeClaimLamports: 5_000_000n,
      minBuybackLamports: 5_000_000n,
      minPlatformPayoutLamports: 5_000_000n,
      liquidityTargetLamports: 170n * SOL,
      minLiquidityAddLamports: 50_000_000n,
      slippageBps: 300,
      maxRoundStepsPerTick: 50,
      maxTickMs: 90_000,
    },
    log: (message) => log(`[keeper] ${message}`),
  });

  /** Volume on the curve: buy, hand the first buy's tokens to test holders, sell the rest back. */
  async function tradeCycle(): Promise<boolean> {
    const balance = BigInt(await connection.getBalance(trader.publicKey, "confirmed"));
    if (balance < SOL / 4n) {
      log("trader is out of SOL; no more volume");
      return false;
    }
    const size = balance - SOL / 10n < TRADE_SIZE_LAMPORTS ? balance - SOL / 10n : TRADE_SIZE_LAMPORTS;
    await curveSwap(connection, dbc, trader, pool, size, false, 500);
    let held = await tokenBalance(connection, indexMint, trader.publicKey);
    if (!r.distributed) {
      // 60% of the first buy to four holders: three clear the $5 threshold, the smallest doesn't.
      const give = (held * 60n) / 100n;
      const shares = [45n, 35n, 17n, 3n];
      const instructions = holders.flatMap((holder, i) => {
        const account = getAssociatedTokenAddressSync(indexMint, holder.publicKey);
        return [
          createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, account, holder.publicKey, indexMint),
          createTransferInstruction(getAssociatedTokenAddressSync(indexMint, trader.publicKey), account, trader.publicKey, (give * shares[i]) / 100n),
        ];
      });
      await sendTransaction(connection, instructions, trader);
      r.distributed = true;
      save();
      log(`gave ${give} STONKFOLIO to ${holders.length} test holders (45/35/17/3%)`);
      held = await tokenBalance(connection, indexMint, trader.publicKey);
    }
    if (held > 0n) await curveSwap(connection, dbc, trader, pool, held, true, 500);
    log(`trader cycled ${sol(size)} SOL through the curve`);
    return true;
  }

  async function verifyFinishedRounds(): Promise<void> {
    const state = store.load();
    const active = new Set([state.round?.roundId, ...state.paying.map((p) => p.roundId)].filter((id) => id !== undefined).map(String));
    const roundsDir = path.join(store.dir, "rounds");
    if (!fs.existsSync(roundsDir)) return;
    for (const id of fs.readdirSync(roundsDir)) {
      if (active.has(id) || r.verifiedRounds.includes(id)) continue;
      const bundle = store.bundleDir(BigInt(id));
      const failuresFile = path.join(store.roundDir(BigInt(id)), "payout-failures.json");
      if (!fs.existsSync(path.join(bundle, "manifest.json")) || !fs.existsSync(failuresFile)) continue;
      const report = verifyRoundArtifacts(bundle);
      const notes = await verifyRoundOnChain(connection, report);
      let landed = 0;
      let total = 0;
      for (const asset of report.prepared.allocation.assets) {
        const account = await client.fetchRoundAsset(BigInt(id), asset.assetIdx);
        for (const leaf of asset.leaves) {
          total++;
          if (account && isLeafClaimed(Buffer.from(account.bitmap), leaf.leafIdx)) landed++;
        }
      }
      const failures: PayoutFailure[] = JSON.parse(fs.readFileSync(failuresFile, "utf-8"));
      const selfClaim = failures.filter((f) => f.permanent).length;
      log(
        `VERIFIED round ${id} against devnet: ${report.assets} asset(s), ${report.recipients} recipient(s), ${landed}/${total} payouts pushed, ${selfClaim} left for self-claim, artifact hash ${report.manifestHash}`
      );
      for (const note of notes) log(`  note: ${note}`);
      r.verifiedRounds.push(id);
      save();
    }
  }

  const pin = await devnetPin(connection);
  const supplyBefore = (await getMint(connection, indexMint, "confirmed")).supply;
  log(`rehearsing ${roundsWanted} round(s) of distributor ${client.distributor.toBase58()} for ${entry.symbol} (pool ${pool.toBase58()})`);
  let nextTradeAt = 0;
  let nextMonitorAt = 0;
  let nextHealthAt = Date.now() + HEALTH_INTERVAL_MS;
  let trading = true;
  const health = { ticks: 0, loopErrors: 0, slowestTickMs: 0 };

  /** Soak only: hands the stand-ins' SOL back to the keeper and keeps the trader funded, so devnet SOL lasts. */
  async function recycle(): Promise<void> {
    const makerBalance = BigInt(await connection.getBalance(marketMaker.publicKey, "confirmed"));
    if (makerBalance > (3n * SOL) / 10n) {
      const amount = makerBalance - SOL / 10n;
      await sendTransaction(connection, [SystemProgram.transfer({ fromPubkey: marketMaker.publicKey, toPubkey: keeper.publicKey, lamports: amount })], marketMaker);
      log(`recycled ${sol(amount)} SOL of basket purchases from the market maker to the keeper`);
    }
    const revenueBalance = BigInt(await connection.getBalance(revenueWallet, "confirmed"));
    if (revenueBalance > SOL / 10n) {
      const amount = revenueBalance - 1_000_000n; // stays above the rent-exempt minimum after the fee
      await sendTransaction(connection, [SystemProgram.transfer({ fromPubkey: revenueWallet, toPubkey: keeper.publicKey, lamports: amount })], keypairOf(r.revenueWallet));
      r.revenueRecycledLamports = (BigInt(r.revenueRecycledLamports ?? "0") + amount).toString();
      save();
      log(`recycled ${sol(amount)} SOL of platform revenue to the keeper`);
    }
    await topUp(connection, keeper, trader.publicKey, (3n * SOL) / 2n);
    trading = true;
  }

  async function iteration(): Promise<void> {
    if (!soaking && Date.now() > deadline) throw new Error(`rehearsal ran out of time after verifying ${r.verifiedRounds.length} round(s)`);
    const keeperBalance = BigInt(await connection.getBalance(keeper.publicKey, "confirmed"));
    if (keeperBalance < (3n * SOL) / 10n) throw new Stop(`STOP: keeper is down to ${sol(keeperBalance)} devnet SOL`);

    if (trading && Date.now() >= nextTradeAt && store.load().ledger.basketLamports < POT_TARGET_LAMPORTS) {
      nextTradeAt = Date.now() + 45_000;
      try {
        trading = await tradeCycle();
      } catch (err) {
        log(`trade failed: ${firstLine(err)}`);
      }
    }
    if (Date.now() >= nextMonitorAt) {
      nextMonitorAt = Date.now() + 10 * 60_000;
      const problems = await checkMeteora(connection, pin);
      log(problems.length === 0 ? "Meteora monitor: devnet programs and config unchanged" : `ALERT: ${problems.join("; ")}`);
      if (soaking) await recycle();
    }

    const tickStarted = Date.now();
    await coin.tick();
    health.ticks++;
    health.slowestTickMs = Math.max(health.slowestTickMs, Date.now() - tickStarted);
    await verifyFinishedRounds();

    if (soaking && Date.now() >= nextHealthAt) {
      nextHealthAt = Date.now() + HEALTH_INTERVAL_MS;
      const memory = process.memoryUsage();
      log(
        `HEALTH up ${Math.round(process.uptime() / 60)} min, ${health.ticks} ticks (slowest ${health.slowestTickMs} ms), ${health.loopErrors} loop error(s), ` +
          `rss ${mb(memory.rss)} MB, heap ${mb(memory.heapUsed)} MB, state ${kb(dirBytes(store.dir))} KB, artifacts ${kb(dirBytes(path.join(work, "artifacts")))} KB, ` +
          `keeper ${sol(keeperBalance)} SOL, rounds verified ${r.verifiedRounds.length}, paying ${store.load().paying.length}`
      );
      health.slowestTickMs = 0;
    }
  }

  while (soaking ? Date.now() < (soakUntil as number) : r.verifiedRounds.length < roundsWanted) {
    try {
      await iteration();
    } catch (err) {
      if (!soaking || err instanceof Stop) throw err;
      health.loopErrors++;
      log(`ERROR (the loop carries on): ${firstLine(err)}`);
    }
    await sleep(5_000);
  }

  const state = store.load();
  const supplyAfter = (await getMint(connection, indexMint, "confirmed")).supply;
  const recycled = BigInt(r.revenueRecycledLamports ?? "0");
  log(soaking ? "soak complete" : "rehearsal complete");
  log(`  rounds verified: ${r.verifiedRounds.join(", ")}`);
  log(`  ledger (SOL): ${Object.entries(state.ledger).map(([k, v]) => `${k} ${sol(v as bigint)}`).join(", ")}`);
  log(`  platform revenue wallet received ${sol(BigInt(await connection.getBalance(revenueWallet, "confirmed")) + recycled)} SOL`);
  log(`  ${platformSymbol} supply burned by buybacks: ${supplyBefore - supplyAfter} raw units`);
  log(`  keeper balance ${sol(await connection.getBalance(keeper.publicKey, "confirmed"))} SOL`);
  if (soaking) log(`  loop errors this run: ${health.loopErrors}; rss ${mb(process.memoryUsage().rss)} MB`);
  lock.release();
});
