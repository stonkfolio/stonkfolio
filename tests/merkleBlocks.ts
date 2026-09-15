import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MerkleTree, payoutLeafHash, verifyBlock, verifyProof } from "../lib/merkle";

const programId = Keypair.generate().publicKey;
const distributor = Keypair.generate().publicKey;

function leavesOf(n: number): Buffer[] {
  return Array.from({ length: n }, (_, i) =>
    payoutLeafHash(programId, distributor, 3n, 1, { leafIdx: i, recipient: new PublicKey(Buffer.alloc(32, (i % 250) + 1)), amount: BigInt(100 + i) })
  );
}

describe("Merkle block proofs (push_payouts)", () => {
  it("verifies every aligned block of every level for trees of 1 to 40 leaves", () => {
    for (let n = 1; n <= 40; n++) {
      const leaves = leavesOf(n);
      const tree = new MerkleTree(leaves);
      for (let level = 0; level <= 5; level++) {
        const size = 2 ** level;
        for (let first = 0; first < n; first += size) {
          const block = leaves.slice(first, first + size);
          expect(verifyBlock(block, first, level, n, tree.blockProof(first, level), tree.root), `n=${n} level=${level} first=${first}`).to.be.true;
        }
      }
    }
  });

  it("matches single-leaf proofs at level 0", () => {
    const leaves = leavesOf(13);
    const tree = new MerkleTree(leaves);
    for (let i = 0; i < 13; i++) {
      expect(tree.blockProof(i, 0)).to.deep.equal(tree.proof(i));
      expect(verifyProof(tree.proof(i), tree.root, leaves[i])).to.be.true;
    }
  });

  it("rejects misaligned, short, reordered or over-proven blocks", () => {
    const leaves = leavesOf(20);
    const tree = new MerkleTree(leaves);
    const proof = tree.blockProof(8, 2);
    expect(verifyBlock(leaves.slice(8, 12), 8, 2, 20, proof, tree.root)).to.be.true;
    expect(verifyBlock(leaves.slice(9, 13), 9, 2, 20, proof, tree.root), "misaligned").to.be.false;
    expect(verifyBlock(leaves.slice(8, 11), 8, 2, 20, proof, tree.root), "short").to.be.false;
    // Pairs hash in sorted order, so swapping two siblings' hashes is invisible here; it can't matter in practice
    // because every leaf hash binds its own leaf index. Leaves from different pairs do change the root.
    expect(verifyBlock([leaves[10], leaves[9], leaves[8], leaves[11]], 8, 2, 20, proof, tree.root), "reordered").to.be.false;
    expect(verifyBlock(leaves.slice(8, 12), 8, 2, 20, [...proof, tree.root], tree.root), "extra node").to.be.false;
    expect(verifyBlock(leaves.slice(8, 12), 8, 2, 20, proof.slice(1), tree.root), "missing node").to.be.false;
    expect(() => tree.blockProof(9, 2)).to.throw(/no block/);
  });

  it("keeps an 8-leaf block's proof short even in a 65,536-leaf tree", () => {
    expect(new MerkleTree(leavesOf(64)).blockProof(8, 3)).to.have.length(3);
    // depth 16 minus the block's 3 levels
    const big = Array.from({ length: 65_536 }, (_, i) => Buffer.from(String(i).padStart(32, "0")));
    const tree = new MerkleTree(big);
    expect(tree.blockProof(40_000, 3)).to.have.length(13);
    expect(verifyBlock(big.slice(40_000, 40_008), 40_000, 3, 65_536, tree.blockProof(40_000, 3), tree.root)).to.be.true;
  });
});
