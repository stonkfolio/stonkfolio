import { expect } from "chai";
import { estimateRoundCost, estimateTransactions, shouldTriggerRound } from "../keeper/round/trigger";
import { decideLiquidity } from "../keeper/liquidity";

const SOL = 1_000_000_000n;

describe("round trigger", () => {
  it("adds up rent, transaction fees and swap impact", () => {
    const cost = estimateRoundCost({
      newTokenAccounts: 1_000,
      tokenAccountRentLamports: 1_488_440n,
      transactions: 10,
      signaturesPerTransaction: 1,
      priorityFeeLamportsPerTransaction: 10_000n,
      swapImpactLamports: 5_000_000n,
    });
    expect(cost).to.equal(1_488_440_000n + 150_000n + 5_000_000n);
  });

  it("counts payout transactions plus commit, per-asset setup and the lookup table", () => {
    expect(estimateTransactions(25, 2, 3)).to.equal(13 + 1 + 3 + 2);
    expect(() => estimateTransactions(1, 0, 1)).to.throw();
  });

  it("runs only once the window is long enough and costs fit within the cap", () => {
    const base = { potLamports: 100n * SOL, estimatedCostLamports: 5n * SOL, maxCostBps: 500, windowStartTs: 0, nowTs: 7_200, minWindowSecs: 3_600 };
    expect(shouldTriggerRound(base)).to.deep.equal({ trigger: true });
    expect(shouldTriggerRound({ ...base, nowTs: 1_000 }).trigger).to.be.false;
    expect(shouldTriggerRound({ ...base, potLamports: 0n }).trigger).to.be.false;
    const expensive = shouldTriggerRound({ ...base, estimatedCostLamports: 5n * SOL + 1n });
    expect(expensive.trigger).to.be.false;
    if (!expensive.trigger) expect(expensive.reason).to.match(/500 bps/);
  });
});

describe("liquidity decision", () => {
  const base = {
    phase: "GRADUATED" as const,
    bucketLamports: 2n * SOL,
    poolQuoteDepthLamports: 100n * SOL,
    targetDepthLamports: 170n * SOL,
    minAddLamports: SOL / 20n,
  };

  it("saves the share until the coin graduates", () => {
    expect(decideLiquidity({ ...base, phase: "CURVE" })).to.deep.equal({ addLamports: 0n, toBasketLamports: 0n, carryLamports: 2n * SOL });
    expect(decideLiquidity({ ...base, phase: "AWAITING_MIGRATION" }).carryLamports).to.equal(2n * SOL);
  });

  it("adds everything while the pool is thin", () => {
    expect(decideLiquidity(base)).to.deep.equal({ addLamports: 2n * SOL, toBasketLamports: 0n, carryLamports: 0n });
  });

  it("fills only up to the target and sends the rest to holders", () => {
    expect(decideLiquidity({ ...base, poolQuoteDepthLamports: 169n * SOL })).to.deep.equal({
      addLamports: SOL,
      toBasketLamports: SOL,
      carryLamports: 0n,
    });
  });

  it("sends everything to holders once the pool is at or near the target", () => {
    expect(decideLiquidity({ ...base, poolQuoteDepthLamports: 170n * SOL }).toBasketLamports).to.equal(2n * SOL);
    expect(decideLiquidity({ ...base, poolQuoteDepthLamports: 170n * SOL - 1n }).toBasketLamports).to.equal(2n * SOL);
  });

  it("keeps saving a small share while the pool still needs liquidity", () => {
    expect(decideLiquidity({ ...base, bucketLamports: SOL / 100n })).to.deep.equal({
      addLamports: 0n,
      toBasketLamports: 0n,
      carryLamports: SOL / 100n,
    });
  });
});
