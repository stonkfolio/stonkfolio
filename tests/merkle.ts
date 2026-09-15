/**
 * Pure TS checks of lib/merkle.ts. Rust/TS parity is proven separately by the
 * validator suite, where every proof built here is verified by the program.
 */
import { expect } from "chai";
import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { MerkleTree, hashPair, payoutLeafHash, verifyProof, MAX_PROOF_LEN, u32le, u64le } from "../lib/merkle";

const PROGRAM_ID = new PublicKey("C4mQLDEnnFupVCwQbr9Bzygr9kJaowRTmmUEb9FoFaLh");

function key(fill: number): PublicKey {
  return new PublicKey(Buffer.alloc(32, fill));
}

const DISTRIBUTOR = key(200);

describe("merkle", () => {
  it("every leaf verifies for trees of 1..9 leaves", () => {
    for (let n = 1; n <= 9; n++) {
      const leaves = Array.from({ length: n }, (_, i) =>
        payoutLeafHash(PROGRAM_ID, DISTRIBUTOR, 3n, 1, { leafIdx: i, recipient: key(i + 1), amount: BigInt(1_000 + i) })
      );
      const tree = new MerkleTree(leaves);
      leaves.forEach((leaf, i) => {
        const proof = tree.proof(i);
        expect(proof.length <= MAX_PROOF_LEN).to.be.true;
        expect(verifyProof(proof, tree.root, leaf), `n=${n} i=${i}`).to.be.true;
      });
    }
  });

  it("matches a hand-composed payout leaf and 3-leaf root (odd node carried up)", () => {
    const recipient = key(7);
    const expectedLeaf = createHash("sha256")
      .update(Buffer.from([0x00]))
      .update(PROGRAM_ID.toBuffer())
      .update(DISTRIBUTOR.toBuffer())
      .update(u64le(5n))
      .update(Buffer.from([2]))
      .update(u32le(0))
      .update(recipient.toBuffer())
      .update(u64le(42n))
      .digest();
    const a = payoutLeafHash(PROGRAM_ID, DISTRIBUTOR, 5n, 2, { leafIdx: 0, recipient, amount: 42n });
    expect(a.equals(expectedLeaf)).to.be.true;

    const b = payoutLeafHash(PROGRAM_ID, DISTRIBUTOR, 5n, 2, { leafIdx: 1, recipient: key(8), amount: 1n });
    const c = payoutLeafHash(PROGRAM_ID, DISTRIBUTOR, 5n, 2, { leafIdx: 2, recipient: key(9), amount: 1n });
    const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
    const ab = createHash("sha256").update(Buffer.from([0x01])).update(lo).update(hi).digest();
    expect(new MerkleTree([a, b, c]).root.equals(hashPair(ab, c))).to.be.true;
  });

  it("binds program, distributor, round, asset, leaf index, recipient and amount", () => {
    const base = { leafIdx: 0, recipient: key(1), amount: 10n };
    const h = payoutLeafHash(PROGRAM_ID, DISTRIBUTOR, 1n, 0, base);
    expect(h.equals(payoutLeafHash(key(99), DISTRIBUTOR, 1n, 0, base))).to.be.false;
    expect(h.equals(payoutLeafHash(PROGRAM_ID, key(98), 1n, 0, base))).to.be.false;
    expect(h.equals(payoutLeafHash(PROGRAM_ID, DISTRIBUTOR, 2n, 0, base))).to.be.false;
    expect(h.equals(payoutLeafHash(PROGRAM_ID, DISTRIBUTOR, 1n, 1, base))).to.be.false;
    expect(h.equals(payoutLeafHash(PROGRAM_ID, DISTRIBUTOR, 1n, 0, { ...base, leafIdx: 1 }))).to.be.false;
    expect(h.equals(payoutLeafHash(PROGRAM_ID, DISTRIBUTOR, 1n, 0, { ...base, recipient: key(2) }))).to.be.false;
    expect(h.equals(payoutLeafHash(PROGRAM_ID, DISTRIBUTOR, 1n, 0, { ...base, amount: 11n }))).to.be.false;
  });

  it("65,536 leaves produce depth-16 proofs", () => {
    const leaves = Array.from({ length: 65_536 }, (_, i) =>
      payoutLeafHash(PROGRAM_ID, DISTRIBUTOR, 1n, 0, { leafIdx: i, recipient: key(1), amount: 1n })
    );
    const tree = new MerkleTree(leaves);
    expect(tree.proof(12_345).length).to.equal(16);
    expect(verifyProof(tree.proof(65_535), tree.root, leaves[65_535])).to.be.true;
  });
});
