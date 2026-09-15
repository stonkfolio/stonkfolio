/**
 * What to do with a coin's liquidity share each tick. Before graduation there
 * is no pool to add to, so it accumulates. After graduation it is added to the
 * coin's permanently locked pool position only while the pool is thinner than
 * the target; once the pool is deep enough the share goes to the basket.
 */

export type PoolPhase = "CURVE" | "AWAITING_MIGRATION" | "GRADUATED";

export interface LiquidityDecisionInput {
  phase: PoolPhase;
  /** SOL accumulated in the liquidity bucket. */
  bucketLamports: bigint;
  /** SOL currently in the graduated pool. */
  poolQuoteDepthLamports: bigint;
  targetDepthLamports: bigint;
  /** Smallest add worth a swap + add + lock transaction. */
  minAddLamports: bigint;
}

export interface LiquidityDecision {
  addLamports: bigint;
  toBasketLamports: bigint;
  carryLamports: bigint;
}

export function decideLiquidity(input: LiquidityDecisionInput): LiquidityDecision {
  const { bucketLamports: bucket } = input;
  if (bucket < 0n) throw new Error("bucket cannot be negative");
  if (input.phase !== "GRADUATED" || bucket === 0n) return { addLamports: 0n, toBasketLamports: 0n, carryLamports: bucket };

  // Swapping half the SOL in and depositing the other half raises the pool's
  // SOL side by about the full amount added.
  const room = input.targetDepthLamports > input.poolQuoteDepthLamports ? input.targetDepthLamports - input.poolQuoteDepthLamports : 0n;
  if (room < input.minAddLamports) {
    // Deep enough (or too close to the target to bother): holders get it instead.
    return { addLamports: 0n, toBasketLamports: bucket, carryLamports: 0n };
  }
  if (bucket < input.minAddLamports) {
    // Pool still needs liquidity; keep saving until an add is worth a transaction.
    return { addLamports: 0n, toBasketLamports: 0n, carryLamports: bucket };
  }
  const add = bucket < room ? bucket : room;
  return { addLamports: add, toBasketLamports: bucket - add, carryLamports: 0n };
}
