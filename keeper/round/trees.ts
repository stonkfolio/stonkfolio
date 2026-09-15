import { PublicKey } from "@solana/web3.js";
import { AssetTuple, MerkleTree, assetLeafHash, payoutLeafHash } from "../../lib/merkle";
import { AssetAllocation } from "./types";

export interface RoundAssetTree extends AssetTuple {
  tree: MerkleTree;
}

export interface RoundTrees {
  /** All zeroes for a round with nothing to pay. */
  assetsRoot: Buffer;
  assetsTree?: MerkleTree;
  assets: RoundAssetTree[];
}

/** Builds each asset's payout tree and the round's asset tree exactly as the distributor verifies them. */
export function buildRoundTrees(
  programId: PublicKey,
  distributor: PublicKey,
  roundId: bigint,
  allocations: AssetAllocation[]
): RoundTrees {
  if (allocations.length === 0) return { assetsRoot: Buffer.alloc(32), assets: [] };
  const assets = allocations.map((allocation, i) => {
    if (allocation.assetIdx !== i) throw new Error(`asset ${allocation.mint} has index ${allocation.assetIdx}, expected ${i}`);
    const tree = new MerkleTree(
      allocation.leaves.map((leaf, leafIdx) => {
        if (leaf.leafIdx !== leafIdx) throw new Error(`leaf index gap in asset ${i}`);
        return payoutLeafHash(programId, distributor, roundId, i, {
          leafIdx,
          recipient: new PublicKey(leaf.recipient),
          amount: leaf.amount,
        });
      })
    );
    return {
      assetIdx: i,
      mint: new PublicKey(allocation.mint),
      tokenProgram: new PublicKey(allocation.tokenProgram),
      merkleRoot: tree.root,
      allocated: allocation.allocated,
      leafCount: allocation.leaves.length,
      tree,
    };
  });
  const assetsTree = new MerkleTree(assets.map((a) => assetLeafHash(programId, distributor, roundId, a)));
  return { assetsRoot: assetsTree.root, assetsTree, assets };
}

/** The JSON-safe summary published as trees.json. */
export function summarizeTrees(trees: RoundTrees) {
  return {
    assetsRoot: trees.assetsRoot.toString("hex"),
    assets: trees.assets.map((a) => ({
      assetIdx: a.assetIdx,
      mint: a.mint.toBase58(),
      tokenProgram: a.tokenProgram.toBase58(),
      merkleRoot: a.merkleRoot.toString("hex"),
      allocated: a.allocated,
      leafCount: a.leafCount,
    })),
  };
}
