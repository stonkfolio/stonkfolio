import { expect } from "chai";
import { JupiterQuote, marginalImpactBps } from "../keeper/jupiter";

const quote = (inAmount: bigint, outAmount: bigint): JupiterQuote => ({
  inputMint: "In",
  inAmount: inAmount.toString(),
  outputMint: "Out",
  outAmount: outAmount.toString(),
  otherAmountThreshold: outAmount.toString(),
  swapMode: "ExactIn",
  slippageBps: 100,
  priceImpactPct: "0",
  routePlan: [],
});

describe("marginalImpactBps", () => {
  it("is zero when the full-size buy gets the reference rate, whatever fee both quotes pay", () => {
    // a 3% transfer fee shaves both quotes by the same share
    expect(marginalImpactBps(quote(1_000_000_000n, 970_000n), quote(10_000_000n, 9_700n))).to.equal(0);
  });

  it("measures only the extra slippage of the full-size buy", () => {
    // the reference gets 0.97 units per 1,000 lamports; full size gets 0.9506, 2% worse
    expect(marginalImpactBps(quote(1_000_000_000n, 950_600n), quote(10_000_000n, 9_700n))).to.equal(200);
  });

  it("never reports negative impact, and can't measure against an empty reference", () => {
    expect(marginalImpactBps(quote(1_000_000_000n, 990_000n), quote(10_000_000n, 9_700n))).to.equal(0);
    expect(marginalImpactBps(quote(1_000_000_000n, 970_000n), quote(10_000_000n, 0n))).to.equal(Number.POSITIVE_INFINITY);
  });
});
