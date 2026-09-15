/**
 * Reads every fee tier config in a deployment file back from the chain and
 * checks each field against the launch settings. Exits non-zero on any
 * mismatch.
 *
 *   node dist/scripts/launch/verify-config.js --rpc <url> --deployment deployments/<cluster>.json
 */
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { checkLaunchConfig } from "../../keeper/meteora/launchConfig";
import { connect, parseArgs, readDeployment, required, run } from "./common";

run(async () => {
  const args = parseArgs();
  const connection = connect(required(args, "rpc"));
  const file = required(args, "deployment");
  const deployment = readDeployment(file);
  if (!deployment) throw new Error(`${file} not found`);
  const client = DynamicBondingCurveClient.create(connection, "confirmed");
  const feeClaimer = new PublicKey(deployment.feeClaimer);

  let failures = 0;
  for (const [bps, address] of Object.entries(deployment.feeTierConfigs)) {
    const config = await client.state.getPoolConfig(address);
    const problems = config
      ? checkLaunchConfig(config, { feeBps: Number(bps), feeClaimer, leftoverReceiver: feeClaimer, quoteMint: NATIVE_MINT })
      : ["config account not found"];
    failures += problems.length;
    console.log(`${problems.length === 0 ? "ok  " : "FAIL"} tier ${bps} bps ${address}`);
    for (const problem of problems) console.log(`       ${problem}`);
  }
  if (failures > 0) throw new Error(`${failures} config mismatch(es)`);
});
