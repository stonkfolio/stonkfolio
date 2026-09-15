/**
 * Re-checks a published Stonkfolio payout round from its artifact bundle.
 *
 *   npm run verify-round -- <bundle-dir> [--rpc <url>]
 *
 * Without --rpc it proves the bundle is internally consistent: every
 * allocation and Merkle root follows from inputs.json. With --rpc it also
 * proves the bundle is the round the distributor program recorded — its fixed
 * policy, the on-chain window, snapshot chain, SOL/USD price and seed, the
 * committed roots, and the basket purchase transactions.
 */
import { Connection } from "@solana/web3.js";
import { verifyRoundArtifacts, verifyRoundOnChain } from "../keeper/round/verify";

async function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--rpc");
  const rpcFlag = args.indexOf("--rpc");
  const rpc = rpcFlag >= 0 ? args[rpcFlag + 1] : undefined;
  if (!dir || (rpcFlag >= 0 && !rpc)) {
    console.error("usage: verify-round <bundle-dir> [--rpc <url>]");
    process.exit(2);
  }

  const report = verifyRoundArtifacts(dir);
  console.log(`round ${report.roundId} of distributor ${report.distributor}`);
  console.log(`  bundle is consistent: ${report.assets} asset(s), ${report.recipients} recipient(s)`);
  console.log(`  artifact hash ${report.manifestHash}`);
  console.log(`  assets root   ${report.assetsRoot}`);

  if (!rpc) {
    console.log("  not checked against the chain (pass --rpc <url>)");
    return;
  }
  const notes = await verifyRoundOnChain(new Connection(rpc, "confirmed"), report);
  console.log(`  matches on-chain round ${report.roundAddress}: policy, window, snapshot chain, price, seed, roots and purchases`);
  for (const note of notes) console.log(`  note: ${note}`);
}

main().catch((err) => {
  console.error(`verification FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
