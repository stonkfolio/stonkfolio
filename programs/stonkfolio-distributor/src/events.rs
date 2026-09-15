use anchor_lang::prelude::*;

use crate::state::AbandonReason;

#[event]
pub struct DistributorCreated {
    pub distributor: Pubkey,
    pub index_mint: Pubkey,
    pub root_authority: Pubkey,
    pub min_expiry_secs: i64,
    pub policy_hash: [u8; 32],
}

#[event]
pub struct RoundOpened {
    pub distributor: Pubkey,
    pub round_id: u64,
    pub secret_commitment: [u8; 32],
    pub open_slot: u64,
}

#[event]
pub struct WindowClosed {
    pub distributor: Pubkey,
    pub round_id: u64,
    pub close_slot: u64,
    pub snapshot_count: u32,
    pub snapshot_chain_head: [u8; 32],
    pub sol_usd_price: i64,
    pub sol_usd_exponent: i32,
}

#[event]
pub struct SeedRecorded {
    pub distributor: Pubkey,
    pub round_id: u64,
    pub seed_slot: u64,
    pub seed_hash: [u8; 32],
}

#[event]
pub struct RoundAbandoned {
    pub distributor: Pubkey,
    pub round_id: u64,
    pub reason: AbandonReason,
    /// The distributor's running count of seed-expired abandons, after this one.
    pub expired_seed_abandons: u32,
}

#[event]
pub struct RoundCommitted {
    pub distributor: Pubkey,
    pub round_id: u64,
    pub assets_root: [u8; 32],
    pub artifact_hash: [u8; 32],
    pub asset_count: u8,
    pub expiry_ts: i64,
}

#[event]
pub struct AssetOpened {
    pub distributor: Pubkey,
    pub round_id: u64,
    pub asset_idx: u8,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub allocated: u64,
    pub leaf_count: u32,
}

#[event]
pub struct AssetActivated {
    pub distributor: Pubkey,
    pub round_id: u64,
    pub asset_idx: u8,
    pub funded: u64,
}

#[event]
pub struct PayoutEvent {
    pub distributor: Pubkey,
    pub round_id: u64,
    pub asset_idx: u8,
    pub leaf_idx: u32,
    pub recipient: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub self_claim: bool,
}

#[event]
pub struct ExcessSwept {
    pub distributor: Pubkey,
    pub round_id: u64,
    pub asset_idx: u8,
    pub amount: u64,
}

#[event]
pub struct AssetClosed {
    pub distributor: Pubkey,
    pub round_id: u64,
    pub asset_idx: u8,
    pub returned: u64,
}

#[event]
pub struct RootAuthorityRotated {
    pub distributor: Pubkey,
    pub previous: Pubkey,
    pub new: Pubkey,
}
