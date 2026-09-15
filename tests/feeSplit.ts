/**
 * Pure math, no chain — feeSplit.ts is entirely deterministic arithmetic on
 * bigints, so this is a plain unit test.
 */
import { expect } from "chai";
import { splitByBps, splitRevenue, FeeSplitBps } from "../keeper/feeSplit";

// Platform 20% (half $STONKFOLIO buyback, half revenue); the other 80% is
// holders-first: basket 70%, coin buyback 5%, liquidity 5%.
const SHARES: FeeSplitBps = {
  basketBps: 7_000,
  coinBuybackBps: 500,
  liquidityBps: 500,
  platformBuybackBps: 1_000,
  platformRevenueBps: 1_000,
};

function total(split: ReturnType<typeof splitRevenue>): bigint {
  return (
    split.basketLamports +
    split.coinBuybackLamports +
    split.liquidityLamports +
    split.platformBuybackLamports +
    split.platformRevenueLamports
  );
}

describe("feeSplit", () => {
  it("splitByBps partitions exactly with no lost units, remainder on the last bucket", () => {
    const amount = 1_000_000_007n; // deliberately not evenly divisible
    const parts = splitByBps(amount, [3_333, 3_333, 3_334]);
    expect(parts.reduce((a, b) => a + b, 0n)).to.equal(amount);
    const naiveLast = (amount * 3_334n) / 10_000n;
    expect(parts[2] >= naiveLast, `${parts[2]} should be >= ${naiveLast}`).to.be.true;
  });

  it("splitByBps throws if shares don't sum to the denominator", () => {
    expect(() => splitByBps(100n, [5_000, 4_999])).to.throw(/expected 10000/);
  });

  it("splitRevenue allocates the full received amount across all five buckets", () => {
    const received = 987_654_321n;
    const split = splitRevenue(received, SHARES);
    expect(total(split)).to.equal(received);
    const naiveBasket = (received * 7_000n) / 10_000n;
    expect(split.basketLamports >= naiveBasket).to.be.true;
    // Basket absorbs at most the 4 other buckets' floor remainders.
    expect(split.basketLamports - naiveBasket < 5n).to.be.true;
  });

  it("splitRevenue matches the per-$4.00 example (5% tier, $100 volume)", () => {
    const split = splitRevenue(4_000_000_000n, SHARES);
    expect(split.basketLamports).to.equal(2_800_000_000n);
    expect(split.coinBuybackLamports).to.equal(200_000_000n);
    expect(split.liquidityLamports).to.equal(200_000_000n);
    expect(split.platformBuybackLamports).to.equal(400_000_000n);
    expect(split.platformRevenueLamports).to.equal(400_000_000n);
  });

  it("splitRevenue handles zero without throwing", () => {
    expect(total(splitRevenue(0n, SHARES))).to.equal(0n);
  });
});
