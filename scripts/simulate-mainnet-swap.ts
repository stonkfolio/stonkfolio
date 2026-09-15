/**
 * Simulates (never sends) a real Jupiter swap — SOL into a real, currently
 * top-graduated StonkFun token — against real mainnet-beta. This is the only
 * way to actually verify Jupiter's router resolves a target mint's
 * TransferHook extra accounts correctly: nothing in Jupiter's public docs
 * confirms this either way (see the mainnet launch plan's research), and it
 * can't be tested against the local mainnet-fork validator since Jupiter's
 * quote/swap API is a hosted mainnet-only service that can't target a local
 * fork. This is the buyBasketAndDeposit leg specifically — SOL into a real
 * graduated token — which is testable today; the STONKFOLIO-selling leg
 * can't be until a real mainnet STONKFOLIO mint exists.
 *
 * A fresh, unfunded keypair is used by default, since this never sends
 * anything — but an unfunded wallet WILL fail simulation on the SOL-wrap
 * step before ever reaching the interesting part (does the hook resolve).
 * Pass a real, SOL-holding wallet via --wallet <path> for a fully faithful
 * test; this script never spends anything from it either way.
 *
 * Usage:
 *   npx tsc -p tsconfig.json
 *   node dist/scripts/simulate-mainnet-swap.js [mint] [--wallet <path>]
 *   (mint defaults to the #1 current top-graduated StonkFun token)
 */
import * as fs from "fs";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getQuote, simulateSwap } from "../keeper/jupiter";
import { getTopGraduatedTokens } from "../keeper/stonkfun";
import { SOL_MINT } from "../keeper/config";

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const TEST_SOL_AMOUNT = 0.1 * LAMPORTS_PER_SOL; // representative buy size — never actually sent

function parseArgs(): { mint?: string; walletPath?: string } {
  const args = process.argv.slice(2);
  const walletFlagIndex = args.indexOf("--wallet");
  const walletPath = walletFlagIndex >= 0 ? args[walletFlagIndex + 1] : undefined;
  const positional = args.filter((_, i) => i !== walletFlagIndex && i !== walletFlagIndex + 1);
  return { mint: positional[0], walletPath };
}

async function main() {
  const { mint: mintArg, walletPath } = parseArgs();
  const connection = new Connection(MAINNET_RPC_URL, "confirmed");

  const wallet = walletPath
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8"))))
    : Keypair.generate();
  if (!walletPath) {
    console.log(`No --wallet given — using a fresh, unfunded keypair (${wallet.publicKey.toBase58()}).`);
    console.log("This never sends anything, but an unfunded wallet may fail simulation on the SOL-wrap step");
    console.log("before reaching the hook-resolution logic. Pass --wallet <path> for a fully faithful test.\n");
  }

  const targetMint = mintArg ?? (await getTopGraduatedTokens(1))[0]?.mint;
  if (!targetMint) {
    throw new Error("no mint provided and StonkFun returned no graduated tokens to default to");
  }
  console.log(`Simulating: swap ${TEST_SOL_AMOUNT / LAMPORTS_PER_SOL} SOL -> ${targetMint} on real mainnet-beta...\n`);

  const quote = await getQuote(SOL_MINT.toBase58(), targetMint, BigInt(TEST_SOL_AMOUNT));
  console.log(`Quote: ${quote.inAmount} lamports in -> ${quote.outAmount} raw out, price impact ${quote.priceImpactPct}%`);

  const result = await simulateSwap(connection, wallet, quote);

  if (!result.err) {
    console.log("\n✔ Simulation succeeded — Jupiter's route (including any transfer-hook resolution) executes cleanly.");
  } else {
    const errText = JSON.stringify(result.err);
    // AccountNotFound, not just "insufficient funds" text, is exactly what
    // a brand-new keypair produces: a real Solana account with zero
    // lamports isn't a low-balance account, it's an account that doesn't
    // exist on the ledger at all until something funds it once. Both error
    // shapes mean the same thing for an unfunded default wallet — neither
    // is a real answer about hook resolution.
    const looksLikeFunding =
      /insufficient/i.test(errText) ||
      /AccountNotFound/i.test(errText) ||
      (result.logs ?? []).some((l) => /insufficient (lamports|funds)/i.test(l));
    console.log(`\n✘ Simulation failed: ${errText}`);
    if (looksLikeFunding && !walletPath) {
      console.log("This looks like the unfunded test wallet's own account not existing/having funds yet, not a");
      console.log("routing/hook problem — re-run with --wallet pointing at a real, SOL-holding keypair for a real answer.");
    } else {
      console.log("This does NOT look like a simple funding issue — investigate the logs below.");
    }
  }
  if (result.logs) {
    console.log("\n--- program logs ---");
    result.logs.forEach((l) => console.log(l));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
