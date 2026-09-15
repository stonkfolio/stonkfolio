import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, AccountLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { FETCH_TIMEOUT_MS, JUPITER_API_BASE, MAX_SWAP_PRIORITY_FEE_LAMPORTS, SLIPPAGE_BPS } from "./config";
import { withBlockhashRetry } from "../lib/confirm";

export const JUPITER_V6_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUJoi5QNyVTaV4");

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
}

export async function getQuote(inputMint: string, outputMint: string, amount: bigint): Promise<JupiterQuote> {
  const url = new URL(`${JUPITER_API_BASE}/quote`);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amount.toString());
  url.searchParams.set("slippageBps", String(SLIPPAGE_BPS));
  url.searchParams.set("swapMode", "ExactIn");
  url.searchParams.set("restrictIntermediateTokens", "true");

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`Jupiter quote error ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as JupiterQuote;
}

/**
 * A quote comes from an API, so nothing in it is trusted: it must be for
 * exactly the swap asked for, and its minimum output can't be looser than the
 * requested slippage allows.
 */
export function checkQuote(quote: JupiterQuote, expected: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }): void {
  const integer = (value: unknown, field: string): bigint => {
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`quote ${field} is not an integer amount`);
    return BigInt(value);
  };
  if (quote.inputMint !== expected.inputMint) throw new Error(`quote input mint ${quote.inputMint} is not ${expected.inputMint}`);
  if (quote.outputMint !== expected.outputMint) throw new Error(`quote output mint ${quote.outputMint} is not ${expected.outputMint}`);
  if (integer(quote.inAmount, "inAmount") !== expected.amount) throw new Error(`quote spends ${quote.inAmount}, not ${expected.amount}`);
  if (quote.swapMode !== "ExactIn") throw new Error(`quote swap mode is ${quote.swapMode}, not ExactIn`);
  if (quote.slippageBps !== expected.slippageBps) throw new Error(`quote slippage is ${quote.slippageBps} bps, not ${expected.slippageBps}`);
  const out = integer(quote.outAmount, "outAmount");
  const min = integer(quote.otherAmountThreshold, "otherAmountThreshold");
  if (out === 0n) throw new Error("quote delivers nothing");
  if (min > out || min * 10_000n < out * BigInt(10_000 - expected.slippageBps)) {
    throw new Error(`quote minimum output ${min} doesn't match ${expected.slippageBps} bps of slippage on ${out}`);
  }
}

async function buildSignedSwapTransaction(wallet: Keypair, quote: JupiterQuote, maxPriorityFeeLamports: bigint): Promise<VersionedTransaction> {
  const res = await fetch(`${JUPITER_API_BASE}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: Number(maxPriorityFeeLamports), priorityLevel: "high" } },
    }),
  });
  if (!res.ok) {
    throw new Error(`Jupiter swap-build error ${res.status}: ${await res.text()}`);
  }
  const { swapTransaction } = (await res.json()) as { swapTransaction: string };
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([wallet]);
  return tx;
}

/** Top-level programs a Jupiter swap transaction may invoke; routing DEXes run inside Jupiter's CPI. */
export const ALLOWED_SWAP_PROGRAMS = new Set(
  [JUPITER_V6_PROGRAM_ID, ComputeBudgetProgram.programId, SystemProgram.programId, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID].map(
    (p) => p.toBase58()
  )
);

/**
 * The swap transaction comes from Jupiter's API, so it's treated as
 * untrusted: the swapping wallet pays and is the only signer, and it calls
 * nothing outside the allow-list. Program ids can't hide in lookup tables —
 * invoked programs must be static keys.
 */
export function checkSwapTransactionShape(tx: VersionedTransaction, wallet: PublicKey): void {
  const { message } = tx;
  const keys = message.staticAccountKeys;
  if (!keys[0]?.equals(wallet)) throw new Error("swap transaction's fee payer is not the swap wallet");
  if (message.header.numRequiredSignatures !== 1) throw new Error("swap transaction needs signers other than the swap wallet");
  for (const instruction of message.compiledInstructions) {
    const program = keys[instruction.programIdIndex];
    if (!program || !ALLOWED_SWAP_PROGRAMS.has(program.toBase58())) {
      throw new Error(`swap transaction invokes unexpected program ${program?.toBase58() ?? "(lookup table)"}`);
    }
  }
}

export interface SwapGuard {
  /** The swap wallet's token account that must receive the output. */
  outputAccount: PublicKey;
  minOutput: bigint;
  /** Most lamports the swap wallet may lose: input plus fees and temporary account rent. */
  maxLamportsSpent: bigint;
}

function tokenAmount(data: Buffer | null | undefined): bigint {
  return data && data.length >= AccountLayout.span ? AccountLayout.decode(data).amount : 0n;
}

/** Simulates the signed swap and checks what it actually does to the swap wallet's balances. */
export async function checkSwapSimulation(connection: Connection, tx: VersionedTransaction, wallet: PublicKey, guard: SwapGuard): Promise<void> {
  const [walletBefore, outputBefore] = await connection.getMultipleAccountsInfo([wallet, guard.outputAccount], "confirmed");
  const { value } = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
    accounts: { encoding: "base64", addresses: [wallet.toBase58(), guard.outputAccount.toBase58()] },
  });
  if (value.err) throw new Error(`swap simulation failed: ${JSON.stringify(value.err)}`);
  const [walletAfter, outputAfter] = value.accounts ?? [];
  if (!walletAfter) throw new Error("swap simulation returned no swap wallet state");
  const lamportsSpent = BigInt(walletBefore?.lamports ?? 0) - BigInt(walletAfter.lamports);
  if (lamportsSpent > guard.maxLamportsSpent) {
    throw new Error(`swap would cost ${lamportsSpent} lamports, more than ${guard.maxLamportsSpent}`);
  }
  const received =
    tokenAmount(outputAfter ? Buffer.from(outputAfter.data[0], "base64") : null) - tokenAmount(outputBefore?.data ?? null);
  if (received < guard.minOutput) throw new Error(`swap would deliver ${received}, less than ${guard.minOutput}`);
}

/**
 * Builds, checks, signs, and sends a Jupiter swap from `wallet`. Price impact
 * is the caller's go/no-go decision, made against the quote before calling this.
 */
export async function executeGuardedSwap(
  connection: Connection,
  wallet: Keypair,
  quote: JupiterQuote,
  guard: SwapGuard,
  maxPriorityFeeLamports: bigint = MAX_SWAP_PRIORITY_FEE_LAMPORTS
): Promise<string> {
  const tx = await buildSignedSwapTransaction(wallet, quote, maxPriorityFeeLamports);
  checkSwapTransactionShape(tx, wallet.publicKey);
  await checkSwapSimulation(connection, tx, wallet.publicKey, guard);
  const rawTx = tx.serialize();
  // Re-sends these same signed bytes on a lagging-node "blockhash not found" rejection (see lib/confirm.ts).
  const signature = await withBlockhashRetry(() => connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 3 }));
  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature, ...latestBlockhash }, "confirmed");
  return signature;
}

/**
 * Builds and signs a real swap exactly like `executeGuardedSwap`, but only
 * simulates it — no funds move. Used to check routing against real mainnet
 * liquidity without a funded wallet.
 */
export async function simulateSwap(
  connection: Connection,
  wallet: Keypair,
  quote: JupiterQuote
): Promise<{ err: unknown; logs: string[] | null; unitsConsumed?: number }> {
  const tx = await buildSignedSwapTransaction(wallet, quote, MAX_SWAP_PRIORITY_FEE_LAMPORTS);
  const { value } = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  return { err: value.err, logs: value.logs, unitsConsumed: value.unitsConsumed ?? undefined };
}

export function priceImpactBps(quote: JupiterQuote): number {
  return Math.round(parseFloat(quote.priceImpactPct) * 10_000);
}

/**
 * Price impact of `quote` measured against a much smaller `reference` quote for
 * the same pair: how much worse the rate is at full size. Transfer fees and pool
 * fees scale with size, so they cancel and only the slippage from trade size
 * remains. Jupiter's own priceImpactPct counts a coin's transfer fee as impact on
 * some routes and not others, so it can't gate buys of fee-charging coins.
 */
export function marginalImpactBps(quote: JupiterQuote, reference: JupiterQuote): number {
  const inQuote = BigInt(quote.inAmount);
  const outQuote = BigInt(quote.outAmount);
  const inReference = BigInt(reference.inAmount);
  const outReference = BigInt(reference.outAmount);
  if (inQuote === 0n || inReference === 0n || outReference === 0n) return Number.POSITIVE_INFINITY;
  // (outQuote / inQuote) / (outReference / inReference), in bps
  const rateBps = (outQuote * inReference * 10_000n) / (inQuote * outReference);
  return rateBps >= 10_000n ? 0 : Number(10_000n - rateBps);
}
