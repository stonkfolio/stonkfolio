/**
 * Pure fee-split math — no chain access, independently unit-testable. The
 * input is the SOL a launched coin actually received from its pool fees,
 * already net of the venue's own share. Everything below is what the keeper
 * does with that balance, in plain TypeScript.
 */

export const TOTAL_BPS = 10_000;

export interface FeeSplitBps {
  /** Bought into the coin's basket and distributed to its holders. */
  basketBps: number;
  /** Buys back and burns the top coins launched through Stonkfolio, by market cap. */
  flywheelBps: number;
  /** Buys back and burns $FOLIO, the platform token. */
  platformBuybackBps: number;
  /** Platform wallet. */
  platformRevenueBps: number;
}

/**
 * Splits `total` into buckets sized by `sharesBps` (must sum to
 * `denominatorBps`). The LAST bucket absorbs the floor-rounding remainder —
 * callers should order `sharesBps` so the largest bucket comes last.
 */
export function splitByBps(total: bigint, sharesBps: number[], denominatorBps: number = TOTAL_BPS): bigint[] {
  const sum = sharesBps.reduce((a, b) => a + b, 0);
  if (sum !== denominatorBps) {
    throw new Error(`splitByBps: shares sum to ${sum}, expected ${denominatorBps}`);
  }
  const amounts = sharesBps.map((bps) => (total * BigInt(bps)) / BigInt(denominatorBps));
  const allocated = amounts.reduce((a, b) => a + b, 0n);
  amounts[amounts.length - 1] += total - allocated;
  return amounts;
}

export interface RevenueSplit {
  basketLamports: bigint;
  flywheelLamports: bigint;
  platformBuybackLamports: bigint;
  platformRevenueLamports: bigint;
}

/** Splits a coin's received fee revenue (lamports) four ways; all buckets stay in SOL. */
export function splitRevenue(lamports: bigint, shares: FeeSplitBps): RevenueSplit {
  // basketBps last so it absorbs the remainder (it's the largest bucket) —
  // see splitByBps's contract.
  const [flywheelLamports, platformBuybackLamports, platformRevenueLamports, basketLamports] =
    splitByBps(lamports, [
      shares.flywheelBps,
      shares.platformBuybackBps,
      shares.platformRevenueBps,
      shares.basketBps,
    ]);
  return { basketLamports, flywheelLamports, platformBuybackLamports, platformRevenueLamports };
}
