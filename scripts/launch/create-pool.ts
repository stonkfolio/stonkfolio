/**
 * Launches a coin on one of the deployment's fee tiers. The creator (the
 * keeper) signs; DBC creates the mint with immutable metadata.
 *
 *   node dist/scripts/launch/create-pool.js --rpc <url> --creator <keypair.json> --deployment deployments/<cluster>.json
 *     --fee-bps 500 --name Stonkfolio --symbol FOLIO --uri <metadata json url>
 *     [--dev-buy-sol 1.5 --min-tokens <raw base units>]
 *
 * A dev buy rides in the same transaction as the pool, so it is the coin's
 * first trade and cannot be sniped. --min-tokens fails the launch if the curve
 * hands back less than expected; take the number from a devnet dry run of the
 * same config and amount.
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
  const devBuySol = args.get("dev-buy-sol");
  const firstBuy = devBuySol
    ? {
        lamports: BigInt(Math.round(Number(devBuySol) * 1e9)),
        minimumAmountOut: BigInt(args.get("min-tokens") ?? "1"),
      }
    : undefined;
  if (firstBuy && firstBuy.lamports <= 0n) throw new Error("--dev-buy-sol must be positive");
  const { pool, baseMint, signature, bought } = await createLaunchPool(
    connection,
    client,
    creator,
    new PublicKey(configAddress),
    metadata,
    firstBuy
  );
  deployment.pools.push({ name: metadata.name, symbol: metadata.symbol, feeBps, pool: pool.toBase58(), baseMint: baseMint.toBase58() });
  writeDeployment(file, deployment);
  console.log(`launched ${metadata.symbol}: pool ${pool.toBase58()}, mint ${baseMint.toBase58()} (${signature})`);
  if (firstBuy) {
    const supply = (await connection.getTokenSupply(baseMint, "confirmed")).value;
    const share = (Number(bought) / Number(supply.amount)) * 100;
    console.log(
      `first buy: ${Number(firstBuy.lamports) / 1e9} SOL bought ${bought} raw (${share.toFixed(2)}% of the ${supply.uiAmountString} supply), held by ${creator.publicKey.toBase58()}`
    );
  }
});
