//! Domain-separated sha256 Merkle hashing. Mirrored exactly by lib/merkle.ts.
//!
//! - payout leaf: sha256(0x00 ‖ program_id ‖ distributor ‖ round_id u64LE ‖ asset_idx u8 ‖ leaf_idx u32LE ‖ recipient ‖ amount u64LE)
//! - internal node: sha256(0x01 ‖ min(a,b) ‖ max(a,b)); an odd node is carried up unchanged
//! - asset tuple leaf: sha256(0x02 ‖ program_id ‖ distributor ‖ round_id ‖ asset_idx ‖ mint ‖ token_program ‖ merkle_root ‖ allocated u64LE ‖ leaf_count u32LE)
//!
//! Binding program_id, distributor, round_id, asset_idx and leaf_idx into
//! every leaf is what prevents a proof from being replayed against another
//! deployment, coin, round, asset, or bitmap slot.
use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::hash::hashv;

pub const LEAF_PREFIX: u8 = 0x00;
pub const NODE_PREFIX: u8 = 0x01;
pub const ASSET_PREFIX: u8 = 0x02;
/// ceil(log2(MAX_LEAVES_PER_ASSET)) = 16, plus headroom.
pub const MAX_PROOF_LEN: usize = 17;

pub fn payout_leaf(
    program_id: &Pubkey,
    distributor: &Pubkey,
    round_id: u64,
    asset_idx: u8,
    leaf_idx: u32,
    recipient: &Pubkey,
    amount: u64,
) -> [u8; 32] {
    hashv(&[
        &[LEAF_PREFIX],
        program_id.as_ref(),
        distributor.as_ref(),
        &round_id.to_le_bytes(),
        &[asset_idx],
        &leaf_idx.to_le_bytes(),
        recipient.as_ref(),
        &amount.to_le_bytes(),
    ])
    .to_bytes()
}

#[allow(clippy::too_many_arguments)]
pub fn asset_leaf(
    program_id: &Pubkey,
    distributor: &Pubkey,
    round_id: u64,
    asset_idx: u8,
    mint: &Pubkey,
    token_program: &Pubkey,
    merkle_root: &[u8; 32],
    allocated: u64,
    leaf_count: u32,
) -> [u8; 32] {
    hashv(&[
        &[ASSET_PREFIX],
        program_id.as_ref(),
        distributor.as_ref(),
        &round_id.to_le_bytes(),
        &[asset_idx],
        mint.as_ref(),
        token_program.as_ref(),
        merkle_root,
        &allocated.to_le_bytes(),
        &leaf_count.to_le_bytes(),
    ])
    .to_bytes()
}

pub fn hash_pair(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    hashv(&[&[NODE_PREFIX], lo, hi]).to_bytes()
}

pub fn verify(proof: &[[u8; 32]], root: &[u8; 32], leaf: [u8; 32]) -> bool {
    let computed = proof.iter().fold(leaf, |node, sibling| hash_pair(&node, sibling));
    computed == *root
}

/// Root of a run of adjacent leaves, paired left to right with an odd node
/// carried up — the same rule the whole tree uses.
fn block_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    let mut level = leaves.to_vec();
    while level.len() > 1 {
        level = level
            .chunks(2)
            .map(|pair| if pair.len() == 2 { hash_pair(&pair[0], &pair[1]) } else { pair[0] })
            .collect();
    }
    level[0]
}

/// Verifies an aligned block of leaves against the root with one shared
/// proof. The block holds leaves `first_leaf..first_leaf + 2^level` (fewer
/// only when it is the tree's last block), so it is exactly one subtree. The
/// proof lists the siblings that subtree's root meets on the way up, skipping
/// levels where it is carried up unpaired.
pub fn verify_block(
    leaves: &[[u8; 32]],
    first_leaf: u32,
    level: u8,
    leaf_count: u32,
    proof: &[[u8; 32]],
    root: &[u8; 32],
) -> bool {
    if level >= 32 || leaves.is_empty() || first_leaf >= leaf_count {
        return false;
    }
    let block_size = 1u64 << level;
    if first_leaf as u64 % block_size != 0 || leaves.len() as u64 != block_size.min((leaf_count - first_leaf) as u64) {
        return false;
    }
    let mut node = block_root(leaves);
    let mut index = first_leaf as u64 >> level;
    let mut level_size = (leaf_count as u64 + block_size - 1) >> level;
    let mut siblings = proof.iter();
    while level_size > 1 {
        if index % 2 == 1 || index + 1 < level_size {
            match siblings.next() {
                Some(sibling) => node = hash_pair(&node, sibling),
                None => return false,
            }
        }
        index /= 2;
        level_size = (level_size + 1) / 2;
    }
    siblings.next().is_none() && node == *root
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_levels(leaves: Vec<[u8; 32]>) -> Vec<Vec<[u8; 32]>> {
        let mut levels = vec![leaves];
        while levels.last().unwrap().len() > 1 {
            let prev = levels.last().unwrap();
            let next = prev
                .chunks(2)
                .map(|pair| if pair.len() == 2 { hash_pair(&pair[0], &pair[1]) } else { pair[0] })
                .collect();
            levels.push(next);
        }
        levels
    }

    fn proof_for(levels: &[Vec<[u8; 32]>], mut index: usize) -> Vec<[u8; 32]> {
        let mut proof = Vec::new();
        for level in &levels[..levels.len() - 1] {
            let sibling = index ^ 1;
            if sibling < level.len() {
                proof.push(level[sibling]);
            }
            index /= 2;
        }
        proof
    }

    #[test]
    fn every_leaf_verifies_for_small_trees() {
        let program_id = Pubkey::new_unique();
        let distributor = Pubkey::new_unique();
        for n in 1..=9u32 {
            let leaves: Vec<[u8; 32]> = (0..n)
                .map(|i| payout_leaf(&program_id, &distributor, 3, 1, i, &Pubkey::new_unique(), 1_000 + i as u64))
                .collect();
            let levels = build_levels(leaves.clone());
            let root = levels.last().unwrap()[0];
            for (i, leaf) in leaves.iter().enumerate() {
                let proof = proof_for(&levels, i);
                assert!(proof.len() <= MAX_PROOF_LEN);
                assert!(verify(&proof, &root, *leaf), "n={n} i={i}");
            }
        }
    }

    #[test]
    fn leaf_fields_are_bound() {
        let program_id = Pubkey::new_unique();
        let distributor = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();
        let base = payout_leaf(&program_id, &distributor, 1, 0, 0, &recipient, 10);
        assert_ne!(base, payout_leaf(&Pubkey::new_unique(), &distributor, 1, 0, 0, &recipient, 10));
        assert_ne!(base, payout_leaf(&program_id, &Pubkey::new_unique(), 1, 0, 0, &recipient, 10));
        assert_ne!(base, payout_leaf(&program_id, &distributor, 2, 0, 0, &recipient, 10));
        assert_ne!(base, payout_leaf(&program_id, &distributor, 1, 1, 0, &recipient, 10));
        assert_ne!(base, payout_leaf(&program_id, &distributor, 1, 0, 1, &recipient, 10));
        assert_ne!(base, payout_leaf(&program_id, &distributor, 1, 0, 0, &Pubkey::new_unique(), 10));
        assert_ne!(base, payout_leaf(&program_id, &distributor, 1, 0, 0, &recipient, 11));
    }

    fn block_proof_for(levels: &[Vec<[u8; 32]>], first_leaf: usize, level: usize) -> Vec<[u8; 32]> {
        let mut proof = Vec::new();
        let mut index = first_leaf >> level;
        for nodes in &levels[level..levels.len() - 1] {
            let sibling = index ^ 1;
            if sibling < nodes.len() {
                proof.push(nodes[sibling]);
            }
            index /= 2;
        }
        proof
    }

    #[test]
    fn every_aligned_block_verifies() {
        let program_id = Pubkey::new_unique();
        let distributor = Pubkey::new_unique();
        for n in 1..=40usize {
            let leaves: Vec<[u8; 32]> = (0..n as u32)
                .map(|i| payout_leaf(&program_id, &distributor, 7, 2, i, &Pubkey::new_unique(), 10 + i as u64))
                .collect();
            let levels = build_levels(leaves.clone());
            let root = levels.last().unwrap()[0];
            for level in 0..=5usize {
                if level >= levels.len() {
                    break;
                }
                let size = 1usize << level;
                for first in (0..n).step_by(size) {
                    let block = &leaves[first..(first + size).min(n)];
                    let proof = block_proof_for(&levels, first, level);
                    assert!(proof.len() <= MAX_PROOF_LEN);
                    assert!(
                        verify_block(block, first as u32, level as u8, n as u32, &proof, &root),
                        "n={n} level={level} first={first}"
                    );
                }
            }
        }
    }

    #[test]
    fn misaligned_short_or_tampered_blocks_fail() {
        let program_id = Pubkey::new_unique();
        let distributor = Pubkey::new_unique();
        let n = 20usize;
        let leaves: Vec<[u8; 32]> = (0..n as u32)
            .map(|i| payout_leaf(&program_id, &distributor, 7, 2, i, &Pubkey::new_unique(), 10 + i as u64))
            .collect();
        let levels = build_levels(leaves.clone());
        let root = levels.last().unwrap()[0];
        let proof = block_proof_for(&levels, 8, 2);
        assert!(verify_block(&leaves[8..12], 8, 2, n as u32, &proof, &root));
        // not on a block boundary
        assert!(!verify_block(&leaves[9..13], 9, 2, n as u32, &block_proof_for(&levels, 9, 2), &root));
        // too few leaves for a full block
        assert!(!verify_block(&leaves[8..11], 8, 2, n as u32, &proof, &root));
        // a leaf swapped for its neighbour's
        let mut swapped = leaves[8..12].to_vec();
        swapped[1] = leaves[13];
        assert!(!verify_block(&swapped, 8, 2, n as u32, &proof, &root));
        // extra or missing proof nodes
        let mut long = proof.clone();
        long.push(root);
        assert!(!verify_block(&leaves[8..12], 8, 2, n as u32, &long, &root));
        assert!(!verify_block(&leaves[8..12], 8, 2, n as u32, &proof[..proof.len() - 1], &root));
        // a proof for another block
        assert!(!verify_block(&leaves[8..12], 8, 2, n as u32, &block_proof_for(&levels, 4, 2), &root));
        // the wrong leaf count changes which nodes are carried up
        assert!(!verify_block(&leaves[16..20], 16, 2, 21, &block_proof_for(&levels, 16, 2), &root));
    }

    #[test]
    fn tampered_proof_fails() {
        let program_id = Pubkey::new_unique();
        let distributor = Pubkey::new_unique();
        let leaves: Vec<[u8; 32]> = (0..4u32)
            .map(|i| payout_leaf(&program_id, &distributor, 1, 0, i, &Pubkey::new_unique(), 5))
            .collect();
        let levels = build_levels(leaves.clone());
        let root = levels.last().unwrap()[0];
        let mut proof = proof_for(&levels, 2);
        proof[0][0] ^= 1;
        assert!(!verify(&proof, &root, leaves[2]));
        assert!(!verify(&proof_for(&levels, 2), &root, leaves[1]));
    }
}
