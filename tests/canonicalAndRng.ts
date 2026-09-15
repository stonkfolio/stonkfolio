import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { canonicalJson } from "../lib/canonicalJson";
import { Sha256Rng, shuffled } from "../lib/rng";

describe("canonicalJson", () => {
  it("sorts every key by code unit, including integer-like keys", () => {
    expect(canonicalJson({ b: 1, a: 2, "10": 3, "9": 4 })).to.equal('{"10":3,"9":4,"a":2,"b":1}');
    expect(canonicalJson({ z: { y: 1, x: [3, { d: 1, c: 2 }] } })).to.equal('{"z":{"x":[3,{"c":2,"d":1}],"y":1}}');
  });

  it("writes bigints as strings, public keys as base58, and omits undefined fields", () => {
    const key = new PublicKey(Buffer.alloc(32, 1));
    expect(canonicalJson({ amount: 12345678901234567890n, key, skip: undefined, none: null })).to.equal(
      `{"amount":"12345678901234567890","key":"${key.toBase58()}","none":null}`
    );
  });

  it("refuses values it can't represent unambiguously", () => {
    expect(() => canonicalJson({ n: NaN })).to.throw(/non-finite/);
    expect(() => canonicalJson({ b: Buffer.alloc(1) })).to.throw(/hex/);
  });
});

describe("Sha256Rng", () => {
  it("is deterministic per seed", () => {
    const a = new Sha256Rng(Buffer.from("seed"));
    const b = new Sha256Rng(Buffer.from("seed"));
    const c = new Sha256Rng(Buffer.from("other"));
    const draws = Array.from({ length: 10 }, () => a.nextU64());
    expect(Array.from({ length: 10 }, () => b.nextU64())).to.deep.equal(draws);
    expect(Array.from({ length: 10 }, () => c.nextU64())).to.not.deep.equal(draws);
  });

  it("draws below n and shuffles into a permutation", () => {
    const rng = new Sha256Rng(Buffer.from("below"));
    expect(rng.below(1n)).to.equal(0n);
    for (let i = 0; i < 200; i++) expect(rng.below(7n) < 7n).to.be.true;
    expect(() => rng.below(0n)).to.throw();

    const items = Array.from({ length: 20 }, (_, i) => i);
    const once = shuffled(items, new Sha256Rng(Buffer.from("shuffle")));
    expect([...once].sort((x, y) => x - y)).to.deep.equal(items);
    expect(shuffled(items, new Sha256Rng(Buffer.from("shuffle")))).to.deep.equal(once);
    expect(items).to.deep.equal(Array.from({ length: 20 }, (_, i) => i));
  });
});
