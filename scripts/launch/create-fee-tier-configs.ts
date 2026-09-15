/**
 * Creates one reusable Meteora DBC config per launch fee tier (3%–5% in 0.5%
 * steps by default) and records their addresses in a deployment file.
 *
 *   node dist/scripts/launch/create-fee-tier-configs.js --rpc <url> --payer <keypair.json>
 *     --fee-claimer <keeper pubkey> --out deployments/<cluster>.json [--cluster <name>] [--tiers 300,500]
 */
import { PublicKey } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { FEE_TIERS_BPS, isFeeTier } from "../../keeper/meteora/launchConfig";
import { createFeeTierConfig } from "../../keeper/meteora/launch";
import { connect, loadKeypair, parseArgs, readDeployment, required, run, writeDeployment } from "./common";

run(async () => {
  const args = parseArgs();
  const connection = connect(required(args, "rpc"));
  const payer = loadKeypair(required(args, "payer"));
  const feeClaimer = new PublicKey(required(args, "fee-claimer"));
  const out = required(args, "out");
  const tiers = (args.get("tiers")?.split(",").map(Number) ?? [...FEE_TIERS_BPS]).map((bps) => {
    if (!isFeeTier(bps)) throw new Error(`${bps} is not a launch fee tier`);
    return bps;
  });

  const deployment = readDeployment(out) ?? { cluster: args.get("cluster") ?? "unknown", feeClaimer: feeClaimer.toBase58(), feeTierConfigs: {}, pools: [] };
  if (deployment.feeClaimer !== feeClaimer.toBase58()) throw new Error(`${out} uses fee claimer ${deployment.feeClaimer}`);

  const client = DynamicBondingCurveClient.create(connection, "confirmed");
  for (const bps of tiers) {
    if (deployment.feeTierConfigs[bps]) {
      console.log(`tier ${bps} bps already exists: ${deployment.feeTierConfigs[bps]}`);
      continue;
    }
    const { config, signature } = await createFeeTierConfig(connection, client, payer, feeClaimer, bps);
    deployment.feeTierConfigs[bps] = config.toBase58();
    writeDeployment(out, deployment); // after each tier, so a failure midway loses nothing
    console.log(`tier ${bps} bps → config ${config.toBase58()} (${signature})`);
  }
});
