/** The real basket: StonkFun's top graduated coins, bought through Jupiter behind the swap guard. */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { vetMintData } from "../lib/tokens";
import { checkQuote, executeGuardedSwap, getQuote, marginalImpactBps } from "./jupiter";
import { getTopGraduatedTokens } from "./stonkfun";
import { BasketCandidate, BasketSource, SwapResult } from "./round/engine";
import { SLIPPAGE_BPS, SOL_MINT } from "./config";

export interface StonkfunBasketOptions {
  basketSize: number;
  maxPriceImpactBps: number;
  minLiquidityUsd: number;
  maxTransferFeeBps: number;
  /** Lamports the swap may use on top of its input for fees and temporary account rent. */
  swapOverheadLamports: bigint;
  maxPriorityFeeLamports: bigint;
  /** Mints never bought (e.g. the platform's own coins). */
  exclude: Set<string>;
}

/** Smallest reference quote used to measure a buy's price impact (0.001 SOL). */
const MIN_REFERENCE_QUOTE_LAMPORTS = 1_000_000n;

export class StonkfunJupiterBasket implements BasketSource {
  constructor(
    private readonly connection: Connection,
    private readonly options: StonkfunBasketOptions
  ) {}

  async select(): Promise<BasketCandidate[]> {
    const { basketSize, minLiquidityUsd, maxTransferFeeBps, exclude } = this.options;
    const tokens = await getTopGraduatedTokens(Math.min(100, basketSize * 2));
    const mints: PublicKey[] = [];
    const seen = new Set<string>();
    for (const token of tokens) {
      if (token.status !== "graduated" || (token.market.liquidityUsd !== undefined && token.market.liquidityUsd < minLiquidityUsd)) continue;
      let mint: PublicKey;
      try {
        mint = new PublicKey(token.mint);
      } catch {
        continue; // one malformed API row shouldn't block the basket
      }
      const key = mint.toBase58();
      if (seen.has(key) || exclude.has(key) || mint.equals(NATIVE_MINT)) continue;
      seen.add(key);
      mints.push(mint);
    }
    const infos = await this.connection.getMultipleAccountsInfo(mints, "confirmed");
    const selected: BasketCandidate[] = [];
    for (const [i, info] of infos.entries()) {
      if (!info) continue;
      // Same rules the distributor enforces on-chain, plus a transfer-fee cap.
      if (!vetMintData(info.data, info.owner, { allowFreezeAuthority: false, maxTransferFeeBps }).ok) continue;
      selected.push({ mint: mints[i], tokenProgram: info.owner });
      if (selected.length === basketSize) break;
    }
    return selected;
  }

  async swap(candidate: BasketCandidate, wallet: Keypair, lamports: bigint): Promise<SwapResult> {
    const { maxPriceImpactBps, maxTransferFeeBps, swapOverheadLamports, maxPriorityFeeLamports } = this.options;
    const quote = await getQuote(SOL_MINT.toBase58(), candidate.mint.toBase58(), lamports);
    checkQuote(quote, { inputMint: SOL_MINT.toBase58(), outputMint: candidate.mint.toBase58(), amount: lamports, slippageBps: SLIPPAGE_BPS });
    // Impact is measured against a quote 1/100th the size, so a coin's transfer fee isn't mistaken for
    // slippage. A buy no bigger than the reference has nothing to measure against and is left alone.
    const referenceLamports = lamports / 100n > MIN_REFERENCE_QUOTE_LAMPORTS ? lamports / 100n : MIN_REFERENCE_QUOTE_LAMPORTS;
    let impact = 0;
    if (referenceLamports < lamports) {
      const reference = await getQuote(SOL_MINT.toBase58(), candidate.mint.toBase58(), referenceLamports);
      checkQuote(reference, { inputMint: SOL_MINT.toBase58(), outputMint: candidate.mint.toBase58(), amount: referenceLamports, slippageBps: SLIPPAGE_BPS });
      impact = marginalImpactBps(quote, reference);
    }
    if (!Number.isFinite(impact) || impact > maxPriceImpactBps) return { skipped: `price impact ${impact} bps exceeds ${maxPriceImpactBps}` };

    const threshold = BigInt(quote.otherAmountThreshold);
    const minOutput = candidate.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
      ? (threshold * BigInt(10_000 - maxTransferFeeBps)) / 10_000n
      : threshold;
    const signature = await executeGuardedSwap(
      this.connection,
      wallet,
      quote,
      {
        outputAccount: getAssociatedTokenAddressSync(candidate.mint, wallet.publicKey, false, candidate.tokenProgram),
        minOutput,
        maxLamportsSpent: lamports + swapOverheadLamports,
      },
      maxPriorityFeeLamports
    );
    return { signature };
  }
}
