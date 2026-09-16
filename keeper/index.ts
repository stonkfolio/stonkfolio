/**
 * The Stonkfolio keeper: a long-running service that operates every coin in a
 * deployment with no human in the loop. Each tick, per coin: settle journaled
 * transactions, migrate a full curve, claim fees into the ledger, pay platform
 * revenue, run both buybacks, add liquidity while the pool is thin, and
 * advance the payout rounds. Each sub-step's errors are logged and retried
 * next tick without blocking the rest.
 *
 * Environment (see deploy/keeper.env.example):
 *   STONKFOLIO_RPC_URL, STONKFOLIO_KEEPER_KEYPAIR, STONKFOLIO_DEPLOYMENT, STONKFOLIO_STATE_DIR,
 *   STONKFOLIO_HELIUS_RPC_URL (holder snapshots on mainnet),
 *   STONKFOLIO_ARTIFACT_REPO_DIR [+ STONKFOLIO_ARTIFACT_REMOTE] or STONKFOLIO_ARTIFACT_DIR,
 *   PLATFORM_REVENUE_ADDRESS,
 *   STONKFOLIO_DISTRIBUTOR_CREATOR (only after a root-authority rotation: the key the distributors were created under)
 */
import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { patchConnectionForPollingConfirmation } from "../lib/confirm";
import { readDeployment } from "../lib/deployment";
import { ProcessLock } from "../lib/lock";
import * as config from "./config";
import { StonkfunJupiterBasket } from "./basket";
import { CoinKeeper } from "./coin";
import { DistributorClient, distributorAddress } from "./distributor/client";
import { HeliusDasSource, HolderSource, RpcProgramAccountsSource } from "./holders/source";
import { LaunchPriceSource } from "./meteora/price";
import { checkMeteora, readMeteoraPin } from "./monitor";
import { RoundEngine } from "./round/engine";
import { ArtifactPublisher, GitRepoPublisher, LocalDirectoryPublisher } from "./round/publisher";
import { KeeperStore } from "./state";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name}`);
  return value;
}

async function run(stateRoot: string, isStopping: () => boolean): Promise<void> {
  const connection = new Connection(config.RPC_URL, "confirmed");
  patchConnectionForPollingConfirmation(connection);
  const keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(config.KEEPER_KEYPAIR_PATH, "utf-8"))));
  const deploymentPath = requireEnv("STONKFOLIO_DEPLOYMENT");
  const deployment = readDeployment(deploymentPath);
  if (!deployment) throw new Error(`${deploymentPath} not found`);
  if (deployment.feeClaimer !== keeper.publicKey.toBase58()) {
    // DBC's fee claimer can't be changed, so a rotated keeper key can't claim this deployment's fees.
    throw new Error(`keeper ${keeper.publicKey.toBase58()} is not this deployment's fee claimer (${deployment.feeClaimer})`);
  }
  const platformToken = deployment.pools.find((p) => p.symbol === config.PLATFORM_TOKEN_SYMBOL);
  if (!platformToken) throw new Error(`deployment has no ${config.PLATFORM_TOKEN_SYMBOL} pool for the platform buyback`);
  const creator = process.env.STONKFOLIO_DISTRIBUTOR_CREATOR ? new PublicKey(process.env.STONKFOLIO_DISTRIBUTOR_CREATOR) : keeper.publicKey;

  const dbc = DynamicBondingCurveClient.create(connection, "confirmed");
  const cpAmm = new CpAmm(connection);
  const holders: HolderSource = process.env.STONKFOLIO_HELIUS_RPC_URL
    ? new HeliusDasSource(process.env.STONKFOLIO_HELIUS_RPC_URL)
    : new RpcProgramAccountsSource(connection);
  const basket = new StonkfunJupiterBasket(connection, {
    basketSize: config.BASKET_SIZE,
    maxPriceImpactBps: config.MAX_PRICE_IMPACT_BPS,
    minLiquidityUsd: config.MIN_QUOTE_LIQUIDITY_USD,
    maxTransferFeeBps: config.MAX_BASKET_TRANSFER_FEE_BPS,
    swapOverheadLamports: config.SWAP_OVERHEAD_LAMPORTS,
    maxPriorityFeeLamports: config.MAX_SWAP_PRIORITY_FEE_LAMPORTS,
    exclude: new Set(deployment.pools.map((p) => p.baseMint)),
  });

  const coins = deployment.pools.map((entry) => {
    const pool = new PublicKey(entry.pool);
    const indexMint = new PublicKey(entry.baseMint);
    const store = new KeeperStore(path.join(stateRoot, entry.pool));
    const client = new DistributorClient(connection, keeper, distributorAddress(indexMint, creator), indexMint);
    const distributor = client.distributor.toBase58();
    const publisher: ArtifactPublisher = process.env.STONKFOLIO_ARTIFACT_REPO_DIR
      ? new GitRepoPublisher(process.env.STONKFOLIO_ARTIFACT_REPO_DIR, distributor, process.env.STONKFOLIO_ARTIFACT_REMOTE)
      : new LocalDirectoryPublisher(requireEnv("STONKFOLIO_ARTIFACT_DIR"), distributor);
    const engine = new RoundEngine({
      connection,
      keeper,
      client,
      indexMint,
      holders,
      price: new LaunchPriceSource(dbc, cpAmm, pool),
      basket,
      publisher,
      store,
      policy: config.roundPolicy(),
      params: config.roundParams(),
      now: () => Math.floor(Date.now() / 1000),
    });
    const label = `[${entry.symbol}]`;
    return {
      label,
      keeper: new CoinKeeper({
        connection,
        keeper,
        dbc,
        cpAmm,
        pool,
        platformTokenPool: new PublicKey(platformToken.pool),
        store,
        engine,
        shares: {
          basketBps: config.BASKET_SHARE_BPS,
          flywheelBps: config.FLYWHEEL_SHARE_BPS,
          platformBuybackBps: config.PLATFORM_BUYBACK_SHARE_BPS,
          platformRevenueBps: config.PLATFORM_REVENUE_SHARE_BPS,
        },
        platformRevenueAddress: config.PLATFORM_REVENUE_ADDRESS,
        thresholds: {
          minFeeClaimLamports: config.MIN_FEE_CLAIM_LAMPORTS,
          minBuybackLamports: config.MIN_BUYBACK_LAMPORTS,
          minPlatformPayoutLamports: config.MIN_PLATFORM_PAYOUT_LAMPORTS,
          liquidityTargetLamports: config.LIQUIDITY_TARGET_LAMPORTS,
          minLiquidityAddLamports: config.MIN_LIQUIDITY_ADD_LAMPORTS,
          slippageBps: config.POOL_SWAP_SLIPPAGE_BPS,
          maxRoundStepsPerTick: config.MAX_ROUND_STEPS_PER_TICK,
          maxTickMs: config.MAX_TICK_MS,
        },
        log: (message) => console.log(`${new Date().toISOString()} ${label} ${message}`),
        shouldStop: isStopping,
      }),
    };
  });

  console.log(`keeper ${keeper.publicKey.toBase58()} operating ${coins.length} coin(s) from ${deploymentPath}`);
  const meteoraPin = readMeteoraPin(config.METEORA_PIN_PATH);
  let nextMonitorAt = 0;
  while (!isStopping()) {
    if (Date.now() >= nextMonitorAt) {
      nextMonitorAt = Date.now() + config.METEORA_MONITOR_INTERVAL_MS;
      try {
        for (const problem of await checkMeteora(connection, meteoraPin)) console.error(`${new Date().toISOString()} ALERT: Meteora ${problem}`);
      } catch (err) {
        console.error(`${new Date().toISOString()} Meteora monitor failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    for (const coin of coins) {
      if (isStopping()) break;
      try {
        await coin.keeper.tick();
      } catch (err) {
        console.error(`${new Date().toISOString()} ${coin.label} tick failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    for (let waited = 0; waited < config.TICK_INTERVAL_MS && !isStopping(); waited += 500) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  console.log("keeper stopped");
}

async function main(): Promise<void> {
  const stateRoot = requireEnv("STONKFOLIO_STATE_DIR");
  // Held for the whole run: a second keeper on the same state would claim and spend twice.
  const lock = ProcessLock.acquire(stateRoot);
  let stopping = false;
  const stop = () => {
    if (!stopping) console.log("stop requested; finishing the current step");
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await run(stateRoot, () => stopping);
  } finally {
    lock.release();
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}
