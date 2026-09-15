import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { allocate, medianRational } from "../keeper/round/allocate";
import { AllocationInput, Snapshot } from "../keeper/round/types";
import { canonicalJson } from "../lib/canonicalJson";
import { Sha256Rng, shuffled } from "../lib/rng";
import { pda, tokenAccount, wallet } from "./helpers/roundFixture";

const TOKEN = TOKEN_PROGRAM_ID.toBase58();
const [A, B, C, D, KEEPER, P] = [wallet(1), wallet(2), wallet(3), wallet(4), wallet(50), pda(1)];
const price = { num: 1n, den: 1n }; // 1 lamport per raw unit

/**
 * Hand-computed scenario. At $100/SOL, $50 = 500,000,000 raw units.
 * TWABs over two samples: A 1.0e9, B 0.5e9 (exactly $50), C 0.55e9, D 0.45e9 ($45, ineligible).
 */
function goldenInput(): AllocationInput {
  const s1: Snapshot = {
    index: 0,
    slot: 10,
    timestamp: 1,
    poolPrice: price,
    accounts: [
      { address: tokenAccount(1), owner: A, amount: 1_000_000_000n },
      { address: tokenAccount(2), owner: B, amount: 600_000_000n },
      { address: tokenAccount(3), owner: C, amount: 200_000_000n },
      { address: tokenAccount(4), owner: C, amount: 200_000_000n },
      { address: tokenAccount(5), owner: P, amount: 5_000_000_000n },
      { address: tokenAccount(6), owner: KEEPER, amount: 9_000_000_000n },
    ],
  };
  const s2: Snapshot = {
    index: 1,
    slot: 20,
    timestamp: 2,
    poolPrice: price,
    accounts: [
      { address: tokenAccount(1), owner: A, amount: 1_000_000_000n },
      { address: tokenAccount(2), owner: B, amount: 400_000_000n },
      { address: tokenAccount(3), owner: C, amount: 700_000_000n },
      { address: tokenAccount(7), owner: D, amount: 900_000_000n },
      { address: tokenAccount(5), owner: P, amount: 5_000_000_000n },
      { address: tokenAccount(6), owner: KEEPER, amount: 9_000_000_000n },
    ],
  };
  return {
    snapshots: [s1, s2],
    exclusions: [{ owner: KEEPER, reason: "keeper wallet" }],
    assets: [
      { mint: wallet(101), tokenProgram: TOKEN, allocatable: 1_000n, minLeafAmount: 0n },
      { mint: wallet(102), tokenProgram: TOKEN, allocatable: 100n, minLeafAmount: 30n },
    ],
    solUsdMicro: 100_000_000n,
    params: { minEligibleUsdMicro: 50_000_000n, maxLeavesPerAsset: 65_536, maxMinLeafPasses: 3 },
  };
}

function amountsByOwner(leaves: { recipient: string; amount: bigint }[]): Record<string, bigint> {
  return Object.fromEntries(leaves.map((l) => [l.recipient, l.amount]));
}

describe("allocate", () => {
  it("matches the hand-computed golden scenario", () => {
    const result = allocate(goldenInput());

    const holders = Object.fromEntries(result.holders.map((h) => [h.owner, h]));
    expect(holders[A].twab).to.equal(1_000_000_000n);
    expect(holders[B].twab).to.equal(500_000_000n);
    expect(holders[B].valueUsdMicro).to.equal(50_000_000n);
    expect(holders[B].eligible, "exactly $50 is eligible").to.be.true;
    expect(holders[C].twab).to.equal(550_000_000n);
    expect(holders[D].sampleBalances).to.deep.equal([0n, 900_000_000n]);
    expect(holders[D].eligible, "$45 is not").to.be.false;
    expect(holders[P]).to.be.undefined;
    expect(holders[KEEPER]).to.be.undefined;
    expect(Object.fromEntries(result.excluded.map((e) => [e.owner, e.reason]))).to.deep.equal({
      [P]: "program-owned (off-curve) wallet",
      [KEEPER]: "keeper wallet",
    });

    // 1000 split 1.0 : 0.5 : 0.55 → floors 487/243/268, remainders go to B then A
    const [basket0, basket1] = result.assets;
    expect(amountsByOwner(basket0.leaves)).to.deep.equal({ [A]: 488n, [B]: 244n, [C]: 268n });
    expect(basket0.allocated).to.equal(1_000n);
    expect(basket0.dust).to.equal(0n);

    // 100 splits 49/24/27; B and C fall under the 30 minimum, A takes all of it
    expect(amountsByOwner(basket1.leaves)).to.deep.equal({ [A]: 100n });
    expect(basket1.droppedBelowMin).to.equal(2);
    expect(basket1.assetIdx).to.equal(1);
  });

  it("orders leaves by public key bytes with sequential leaf indices", () => {
    const { leaves } = allocate(goldenInput()).assets[0];
    leaves.forEach((leaf, i) => {
      expect(leaf.leafIdx).to.equal(i);
      if (i > 0) {
        expect(Buffer.compare(new PublicKey(leaves[i - 1].recipient).toBuffer(), new PublicKey(leaf.recipient).toBuffer())).to.equal(-1);
      }
    });
  });

  it("is independent of snapshot and row order", () => {
    const input = goldenInput();
    const rng = new Sha256Rng(Buffer.from("order"));
    const reordered: AllocationInput = {
      ...input,
      snapshots: shuffled(input.snapshots, rng).map((s) => ({ ...s, accounts: shuffled(s.accounts, rng) })),
    };
    expect(canonicalJson(allocate(reordered))).to.equal(canonicalJson(allocate(input)));
  });

  it("assigns every unit and stays within one unit of exact pro-rata across random scenarios", () => {
    const rng = new Sha256Rng(Buffer.from("allocate-properties"));
    for (let scenario = 0; scenario < 60; scenario++) {
      const holderCount = 1 + Number(rng.below(40n));
      const sampleCount = 1 + Number(rng.below(5n));
      const snapshots: Snapshot[] = Array.from({ length: sampleCount }, (_, index) => ({
        index,
        slot: index * 10,
        timestamp: index,
        poolPrice: { num: 1n, den: 1n },
        accounts: Array.from({ length: holderCount }, (_, h) => ({
          address: tokenAccount(h + 1),
          owner: wallet(h + 1),
          amount: rng.below(5_000_000_000n),
        })),
      }));
      const allocatable = 1n + rng.below(10_000_000_000n);
      const result = allocate({
        snapshots,
        exclusions: [],
        assets: [{ mint: wallet(200), tokenProgram: TOKEN, allocatable, minLeafAmount: 0n }],
        solUsdMicro: 100_000_000n,
        params: { minEligibleUsdMicro: 50_000_000n, maxLeavesPerAsset: 65_536, maxMinLeafPasses: 3 },
      });
      const eligible = result.holders.filter((h) => h.eligible);
      if (eligible.length === 0) {
        expect(result.assets).to.have.length(0);
        expect(result.skipped).to.have.length(1);
        continue;
      }
      const asset = result.assets[0];
      expect(asset.allocated, `scenario ${scenario}`).to.equal(allocatable);
      const totalWeight = eligible.reduce((sum, h) => sum + h.twab, 0n);
      const twab = new Map(eligible.map((h) => [h.owner, h.twab]));
      for (const leaf of asset.leaves) {
        const exact = allocatable * twab.get(leaf.recipient)!;
        const scaled = leaf.amount * totalWeight;
        const gap = scaled > exact ? scaled - exact : exact - scaled;
        expect(gap < totalWeight, `scenario ${scenario} leaf ${leaf.leafIdx}`).to.be.true;
      }
    }
  });

  it("keeps the largest holders when an asset exceeds maxLeavesPerAsset", () => {
    const input = goldenInput();
    input.params.maxLeavesPerAsset = 2;
    const [asset] = allocate(input).assets;
    expect(Object.keys(amountsByOwner(asset.leaves)).sort()).to.deep.equal([A, C].sort());
    expect(asset.truncated).to.equal(1);
    expect(asset.allocated).to.equal(1_000n);
  });

  it("stops redistributing after maxMinLeafPasses", () => {
    const input = goldenInput();
    input.params.maxMinLeafPasses = 0;
    const basket1 = allocate(input).assets[1];
    expect(amountsByOwner(basket1.leaves)).to.deep.equal({ [A]: 49n, [B]: 24n, [C]: 27n });
    expect(basket1.droppedBelowMin).to.equal(0);
  });

  it("skips assets with nothing to allocate or nobody eligible, keeping indices dense", () => {
    const input = goldenInput();
    input.assets = [
      { mint: wallet(101), tokenProgram: TOKEN, allocatable: 0n, minLeafAmount: 0n },
      { mint: wallet(102), tokenProgram: TOKEN, allocatable: 10n, minLeafAmount: 1_000n },
      { mint: wallet(103), tokenProgram: TOKEN, allocatable: 10n, minLeafAmount: 0n },
    ];
    const result = allocate(input);
    expect(result.skipped.map((s) => s.mint)).to.deep.equal([wallet(101), wallet(102)]);
    expect(result.assets.map((a) => [a.assetIdx, a.mint])).to.deep.equal([[0, wallet(103)]]);

    input.params.minEligibleUsdMicro = 1_000_000_000_000n;
    expect(allocate(input).assets).to.have.length(0);
  });

  it("rejects malformed input", () => {
    const duplicateRow = goldenInput();
    duplicateRow.snapshots[0].accounts.push({ ...duplicateRow.snapshots[0].accounts[0] });
    expect(() => allocate(duplicateRow)).to.throw(/listed twice/);

    const duplicateMint = goldenInput();
    duplicateMint.assets[1].mint = duplicateMint.assets[0].mint;
    expect(() => allocate(duplicateMint)).to.throw(/duplicate asset mint/);

    const tooMany = goldenInput();
    tooMany.assets = Array.from({ length: 31 }, (_, i) => ({ mint: wallet(110 + i), tokenProgram: TOKEN, allocatable: 1n, minLeafAmount: 0n }));
    expect(() => allocate(tooMany)).to.throw(/at most 30/);

    const noSnapshots = goldenInput();
    noSnapshots.snapshots = [];
    expect(() => allocate(noSnapshots)).to.throw(/at least one snapshot/);
  });

  it("uses the lower median pool price", () => {
    const median = medianRational([
      { num: 1n, den: 3n },
      { num: 3n, den: 4n },
      { num: 1n, den: 2n },
      { num: 2n, den: 3n },
    ]);
    expect(median).to.deep.equal({ num: 1n, den: 2n });
  });
});
