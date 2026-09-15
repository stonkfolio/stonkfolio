import { expect } from "chai";
import { deriveSampleSeed, selectSampleIndices } from "../keeper/round/select";

const SEED_HASH = Buffer.alloc(32, 9);
const SECRET = Buffer.alloc(32, 7);
const candidates = Array.from({ length: 10 }, (_, index) => ({ index, slot: 10 + index * 10 }));
const window = { startSlot: 20, endSlot: 80 };

describe("sample selection", () => {
  it("derives the seed from round id, seed block hash and secret", () => {
    const seed = deriveSampleSeed(3n, SEED_HASH, SECRET);
    expect(deriveSampleSeed(3n, SEED_HASH, SECRET).equals(seed)).to.be.true;
    expect(deriveSampleSeed(4n, SEED_HASH, SECRET).equals(seed)).to.be.false;
    expect(deriveSampleSeed(3n, Buffer.alloc(32, 8), SECRET).equals(seed)).to.be.false;
    expect(deriveSampleSeed(3n, SEED_HASH, Buffer.alloc(32, 6)).equals(seed)).to.be.false;
    expect(() => deriveSampleSeed(3n, SEED_HASH, Buffer.alloc(8))).to.throw(/at least 16 bytes/);
    expect(() => deriveSampleSeed(3n, Buffer.alloc(31), SECRET)).to.throw(/32 bytes/);
  });

  it("picks k in-window snapshots in slot order, reproducibly", () => {
    const seed = deriveSampleSeed(1n, SEED_HASH, SECRET);
    const picked = selectSampleIndices(candidates, window, 3, seed);
    expect(picked).to.have.length(3);
    expect(picked).to.deep.equal(selectSampleIndices([...candidates].reverse(), window, 3, seed));
    for (const index of picked) {
      const slot = candidates[index].slot;
      expect(slot >= window.startSlot && slot <= window.endSlot).to.be.true;
    }
    expect([...picked].sort((a, b) => candidates[a].slot - candidates[b].slot)).to.deep.equal(picked);
  });

  it("takes every in-window snapshot when there are k or fewer", () => {
    const seed = deriveSampleSeed(1n, SEED_HASH, SECRET);
    expect(selectSampleIndices(candidates, window, 50, seed)).to.deep.equal([1, 2, 3, 4, 5, 6, 7]);
  });

  it("picks each candidate about equally often across seeds", () => {
    const counts = new Array(5).fill(0);
    const five = candidates.slice(0, 5);
    for (let r = 0n; r < 2_000n; r++) {
      const [index] = selectSampleIndices(five, { startSlot: 0, endSlot: 1_000 }, 1, deriveSampleSeed(r, SEED_HASH, SECRET));
      counts[index]++;
    }
    for (const count of counts) expect(count).to.be.within(320, 480);
  });

  it("rejects duplicate indices and bad k", () => {
    const seed = deriveSampleSeed(1n, SEED_HASH, SECRET);
    expect(() => selectSampleIndices([...candidates, candidates[0]], window, 3, seed)).to.throw(/duplicate/);
    expect(() => selectSampleIndices(candidates, window, 0, seed)).to.throw(/positive integer/);
  });
});
