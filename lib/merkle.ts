/**
 * Domain-separated sha256 Merkle trees — the exact mirror of
 * programs/stonkfolio-distributor/src/merkle.rs. Any change here must be made
 * there too; the validator tests (tests-validator/distributor.ts) prove parity
 * by verifying every TS-built proof on-chain.
 *
 * - payout leaf: sha256(0x00 ‖ program_id ‖ distributor ‖ round_id u64LE ‖ asset_idx u8 ‖ leaf_idx u32LE ‖ recipient ‖ amount u64LE)
 * - internal node: sha256(0x01 ‖ min(a,b) ‖ max(a,b)); an odd node is carried up unchanged
 * - asset tuple leaf: sha256(0x02 ‖ program_id ‖ distributor ‖ round_id ‖ asset_idx ‖ mint ‖ token_program ‖ merkle_root ‖ allocated u64LE ‖ leaf_count u32LE)
 */
import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";

export const LEAF_PREFIX = 0x00;
export const NODE_PREFIX = 0x01;
export const ASSET_PREFIX = 0x02;
export const MAX_PROOF_LEN = 17;

function sha256(parts: Buffer[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

export function u64le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

export function u32le(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

function u8(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error(`not a u8: ${value}`);
  return Buffer.from([value]);
}

export interface PayoutLeaf {
  leafIdx: number;
  recipient: PublicKey;
  amount: bigint;
}

export function payoutLeafHash(
  programId: PublicKey,
  distributor: PublicKey,
  roundId: bigint,
  assetIdx: number,
  leaf: PayoutLeaf
): Buffer {
  return sha256([
    Buffer.from([LEAF_PREFIX]),
    programId.toBuffer(),
    distributor.toBuffer(),
    u64le(roundId),
    u8(assetIdx),
    u32le(leaf.leafIdx),
    leaf.recipient.toBuffer(),
    u64le(leaf.amount),
  ]);
}

export interface AssetTuple {
  assetIdx: number;
  mint: PublicKey;
  tokenProgram: PublicKey;
  merkleRoot: Buffer;
  allocated: bigint;
  leafCount: number;
}

export function assetLeafHash(programId: PublicKey, distributor: PublicKey, roundId: bigint, asset: AssetTuple): Buffer {
  return sha256([
    Buffer.from([ASSET_PREFIX]),
    programId.toBuffer(),
    distributor.toBuffer(),
    u64le(roundId),
    u8(asset.assetIdx),
    asset.mint.toBuffer(),
    asset.tokenProgram.toBuffer(),
    asset.merkleRoot,
    u64le(asset.allocated),
    u32le(asset.leafCount),
  ]);
}

export function hashPair(a: Buffer, b: Buffer): Buffer {
  const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return sha256([Buffer.from([NODE_PREFIX]), lo, hi]);
}

export class MerkleTree {
  readonly levels: Buffer[][];

  constructor(leaves: Buffer[]) {
    if (leaves.length === 0) throw new Error("MerkleTree needs at least one leaf");
    const levels: Buffer[][] = [leaves];
    while (levels[levels.length - 1].length > 1) {
      const prev = levels[levels.length - 1];
      const next: Buffer[] = [];
      for (let i = 0; i < prev.length; i += 2) {
        next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
      }
      levels.push(next);
    }
    this.levels = levels;
  }

  get root(): Buffer {
    return this.levels[this.levels.length - 1][0];
  }

  proof(index: number): Buffer[] {
    if (index < 0 || index >= this.levels[0].length) throw new Error(`leaf index ${index} out of range`);
    return this.blockProof(index, 0);
  }

  /**
   * The shared proof for the aligned block `firstLeaf..firstLeaf + 2^level`:
   * the siblings that block's subtree root meets on the way up (what
   * `push_payouts` verifies with `verify_block`).
   */
  blockProof(firstLeaf: number, level: number): Buffer[] {
    const size = 2 ** level;
    if (!Number.isInteger(level) || level < 0 || firstLeaf % size !== 0 || firstLeaf < 0 || firstLeaf >= this.levels[0].length) {
      throw new Error(`no block of level ${level} starts at leaf ${firstLeaf}`);
    }
    const proof: Buffer[] = [];
    let idx = firstLeaf / size;
    for (const level_ of this.levels.slice(level, -1)) {
      const sibling = idx ^ 1;
      if (sibling < level_.length) proof.push(level_[sibling]);
      idx = Math.floor(idx / 2);
    }
    return proof;
  }
}

export function verifyProof(proof: Buffer[], root: Buffer, leaf: Buffer): boolean {
  return proof.reduce((node, sibling) => hashPair(node, sibling), leaf).equals(root);
}

/** Mirror of `verify_block` in merkle.rs: an aligned block of leaves against the root with one shared proof. */
export function verifyBlock(leaves: Buffer[], firstLeaf: number, level: number, leafCount: number, proof: Buffer[], root: Buffer): boolean {
  const size = 2 ** level;
  if (level < 0 || level >= 32 || leaves.length === 0 || firstLeaf >= leafCount || firstLeaf % size !== 0) return false;
  if (leaves.length !== Math.min(size, leafCount - firstLeaf)) return false;
  let nodes = leaves;
  while (nodes.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < nodes.length; i += 2) next.push(i + 1 < nodes.length ? hashPair(nodes[i], nodes[i + 1]) : nodes[i]);
    nodes = next;
  }
  let node = nodes[0];
  let index = firstLeaf / size;
  let levelSize = Math.ceil(leafCount / size);
  let used = 0;
  while (levelSize > 1) {
    if (index % 2 === 1 || index + 1 < levelSize) {
      if (used >= proof.length) return false;
      node = hashPair(node, proof[used++]);
    }
    index = Math.floor(index / 2);
    levelSize = Math.ceil(levelSize / 2);
  }
  return used === proof.length && node.equals(root);
}
