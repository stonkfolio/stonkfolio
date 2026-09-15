/**
 * Launches a coin on one of the deployment's fee tiers. The creator (the
 * keeper) signs; DBC creates the mint with immutable metadata.
 *
 *   node dist/scripts/launch/create-pool.js --rpc <url> --creator <keypair.json> --deployment deployments/<cluster>.json
 *     --fee-bps 500 --name Stonkfolio --symbol FOLIO --uri <metadata json url>
 *
 * The first mainnet pool must be the platform coin: the keeper's platform
 * buyback looks it up by symbol.
 */
import { PublicKey } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { PLATFORM_TOKEN_SYMBOL } from "../../keeper/config";
import { createLaunchPool } from "../../keeper/meteora/launch";
import { connect, loadKeypair, parseArgs, readDeployment, required, run, writeDeployment } from "./common";

run(async () => {
  const args = parseArgs();
  const connection = connect(required(args, "rpc"));
  const creator = loadKeypair(required(args, "creator"));
  const file = required(args, "deployment");
  const deployment = readDeployment(file);
  if (!deployment) throw new Error(`${file} not found — create the fee tier configs first`);
  const feeBps = Number(required(args, "fee-bps"));
  const configAddress = deployment.feeTierConfigs[feeBps];
  if (!configAddress) throw new Error(`no config for ${feeBps} bps in ${file}`);
  const metadata = { name: required(args, "name"), symbol: required(args, "symbol"), uri: required(args, "uri") };
  // Devnet's test coin predates the FOLIO symbol; everywhere else the first pool is the platform coin.
  if (deployment.cluster !== "devnet" && deployment.pools.length === 0 && metadata.symbol !== PLATFORM_TOKEN_SYMBOL) {
    throw new Error(`the first pool must be the platform coin, symbol ${PLATFORM_TOKEN_SYMBOL} (got ${metadata.symbol})`);
  }
  if (deployment.pools.some((p) => p.symbol === metadata.symbol)) {
    throw new Error(`${file} already has a pool with symbol ${metadata.symbol}`);
  }

  const client = DynamicBondingCurveClient.create(connection, "confirmed");
  const { pool, baseMint, signature } = await createLaunchPool(connection, client, creator, new PublicKey(configAddress), metadata);
  deployment.pools.push({ name: metadata.name, symbol: metadata.symbol, feeBps, pool: pool.toBase58(), baseMint: baseMint.toBase58() });
  writeDeployment(file, deployment);
  console.log(`launched ${metadata.symbol}: pool ${pool.toBase58()}, mint ${baseMint.toBase58()} (${signature})`);
});
