/**
 * When to run a payout round: no schedule and no human — a round starts once
 * the pot is large enough that its costs are a small share of it.
 */

export const LAMPORTS_PER_SIGNATURE = 5_000n;

export interface RoundCostInput {
  /** Recipient token accounts that don't exist yet (holder × basket coin pairs). */
  newTokenAccounts: number;
  tokenAccountRentLamports: bigint;
  transactions: number;
  signaturesPerTransaction: number;
  priorityFeeLamportsPerTransaction: bigint;
  /** Expected value lost to price impact when buying the basket. */
  swapImpactLamports: bigint;
}

/** Payout transactions plus fixed setup (commit, open/fund/activate per asset, lookup table). */
export function estimateTransactions(payouts: number, payoutsPerTransaction: number, assets: number): number {
  if (payoutsPerTransaction < 1) throw new Error("payoutsPerTransaction must be at least 1");
  const payoutTransactions = Math.ceil(payouts / payoutsPerTransaction);
  const setupTransactions = 1 + assets + 2;
  return payoutTransactions + setupTransactions;
}

/**
 * Rent for round accounts (header, per-asset state, vaults) is refunded when
 * assets close, so it's working capital rather than cost and isn't counted.
 */
export function estimateRoundCost(input: RoundCostInput): bigint {
  const rent = BigInt(input.newTokenAccounts) * input.tokenAccountRentLamports;
  const perTransaction = BigInt(input.signaturesPerTransaction) * LAMPORTS_PER_SIGNATURE + input.priorityFeeLamportsPerTransaction;
  return rent + BigInt(input.transactions) * perTransaction + input.swapImpactLamports;
}

export interface TriggerInput {
  /** SOL waiting in the basket bucket. */
  potLamports: bigint;
  estimatedCostLamports: bigint;
  /** Largest acceptable cost as a share of the pot, in basis points. */
  maxCostBps: number;
  windowStartTs: number;
  nowTs: number;
  minWindowSecs: number;
}

export type TriggerDecision = { trigger: true } | { trigger: false; reason: string };

export function shouldTriggerRound(input: TriggerInput): TriggerDecision {
  const elapsed = input.nowTs - input.windowStartTs;
  if (elapsed < input.minWindowSecs) {
    return { trigger: false, reason: `window open ${elapsed}s, needs ${input.minWindowSecs}s` };
  }
  if (input.potLamports <= 0n) return { trigger: false, reason: "pot is empty" };
  if (input.estimatedCostLamports * 10_000n > input.potLamports * BigInt(input.maxCostBps)) {
    return {
      trigger: false,
      reason: `estimated cost ${input.estimatedCostLamports} lamports is more than ${input.maxCostBps} bps of the ${input.potLamports} lamport pot`,
    };
  }
  return { trigger: true };
}
