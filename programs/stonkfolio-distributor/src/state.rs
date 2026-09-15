use anchor_lang::prelude::*;

/// Launchpad baskets hold up to 30 coins; one asset per coin per round.
pub const MAX_ASSETS_PER_ROUND: u8 = 30;
/// Keeps the claim bitmap at <= 8,192 bytes so `RoundAsset` stays under the
/// 10,240-byte limit for accounts created via CPI.
pub const MAX_LEAVES_PER_ASSET: u32 = 65_536;
/// SlotHashes holds the last 512 slots; the seed block must still be in it when recorded.
pub const MAX_SEED_SLOT_OFFSET: u16 = 256;
pub const MAX_MIN_EXPIRY_SECS: i64 = 10 * 365 * 24 * 60 * 60;
/// A seeded round that still hasn't been committed after this long can be
/// abandoned — an escape if the keeper's secret is lost, far too slow to be a
/// useful way to discard an unwanted draw.
pub const SEEDED_ABANDON_DELAY_SECS: i64 = 7 * 24 * 60 * 60;
/// A closed round whose seed block aged out unrecorded can only be abandoned
/// this long after its window closed. Anyone can see the seed block's hash
/// before it is recorded, so without the wait a keeper could skip recording a
/// draw it dislikes and retry within minutes; with it each retry costs a day
/// and is counted on the distributor. An honest outage pauses rounds at most a day.
pub const EXPIRED_SEED_ABANDON_DELAY_SECS: i64 = 24 * 60 * 60;
/// Highest Token-2022 transfer fee (current or scheduled) a basket mint may carry.
/// StonkFun's reward-mode coins charge 1-3%, many with a fee authority that can
/// still change it; see token_utils::vet_mint for what that authority can and can't do.
pub const MAX_TRANSFER_FEE_BPS: u16 = 300;

/// One per launched index coin. Seeded by `(index_mint, creator)`, so anyone
/// can create a distributor but never under someone else's key — no global
/// admin decides who may launch, and nobody can squat another keeper's slot.
///
/// Everything a round's allocation depends on besides the snapshots is fixed
/// here at creation: the published round policy (by hash), the SOL/USD price
/// feed and its freshness rules, and the sampling timing rules.
#[account]
pub struct Distributor {
    pub index_mint: Pubkey,
    /// Original root authority; part of the PDA seeds, never changes.
    pub creator: Pubkey,
    /// The automated keeper: runs rounds and receives excess and expired
    /// funds to roll into the next round. The only key with any power here.
    pub root_authority: Pubkey,
    pub pending_root_authority: Option<Pubkey>,
    /// Fixed at creation: every round stays claimable at least this long.
    pub min_expiry_secs: i64,
    pub next_round_id: u64,
    pub bump: u8,
    /// sha256 of the canonical round policy JSON every round must publish.
    pub policy_hash: [u8; 32],
    /// Pyth PriceUpdateV2 account read when a round's window closes.
    pub price_feed_account: Pubkey,
    pub price_feed_id: [u8; 32],
    pub max_price_age_secs: u32,
    pub max_price_conf_bps: u16,
    /// Slots after a window closes before the block whose hash seeds sampling.
    pub seed_slot_offset: u16,
    pub min_window_secs: u32,
    /// Rounds abandoned because their seed block aged out unrecorded — each one
    /// a possible re-draw, so it is kept as a public count.
    pub expired_seed_abandons: u32,
}

impl Distributor {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + (1 + 32) + 8 + 8 + 1 + 32 + 32 + 32 + 4 + 2 + 2 + 4 + 4;
}

/// Why a round was abandoned, as emitted in `RoundAbandoned`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AbandonReason {
    /// Before the window closed.
    WindowOpen,
    /// The seed block aged out of SlotHashes before anyone recorded it.
    SeedExpired,
    /// Seeded but never committed: the escape for a lost secret.
    SecretLost,
}

/// Whether a round in `status` may be abandoned now, and why. `seed_expired`
/// is only consulted for a closed round.
pub fn abandon_reason(status: IntentStatus, seed_expired: bool, now: i64, close_ts: i64, seed_ts: i64) -> Option<AbandonReason> {
    match status {
        IntentStatus::Open => Some(AbandonReason::WindowOpen),
        IntentStatus::Closed if seed_expired && now >= close_ts.saturating_add(EXPIRED_SEED_ABANDON_DELAY_SECS) => {
            Some(AbandonReason::SeedExpired)
        }
        IntentStatus::Seeded if now >= seed_ts.saturating_add(SEEDED_ABANDON_DELAY_SECS) => Some(AbandonReason::SecretLost),
        _ => None,
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum IntentStatus {
    /// Secret committed; snapshots being taken.
    Open,
    /// Window closed: snapshot chain head and SOL/USD price recorded.
    Closed,
    /// Seed block hash recorded; the round can only be committed now.
    Seeded,
    Committed,
    Abandoned,
}

/// The on-chain record that makes a round's sampling tamper-evident: the
/// keeper commits its secret before snapshots, the program records the window
/// and price at close, and the program — not the keeper — picks the seed block.
#[account]
pub struct RoundIntent {
    pub distributor: Pubkey,
    pub round_id: u64,
    pub status: IntentStatus,
    pub bump: u8,
    pub secret_commitment: [u8; 32],
    pub open_slot: u64,
    pub open_ts: i64,
    pub close_slot: u64,
    pub close_ts: i64,
    pub snapshot_chain_head: [u8; 32],
    pub snapshot_count: u32,
    pub sol_usd_price: i64,
    pub sol_usd_conf: u64,
    pub sol_usd_exponent: i32,
    pub sol_usd_publish_time: i64,
    pub seed_slot: u64,
    pub seed_hash: [u8; 32],
    pub seed_ts: i64,
}

impl RoundIntent {
    pub const SIZE: usize = 8 + 32 + 8 + 1 + 1 + 32 + 8 + 8 + 8 + 8 + 32 + 4 + 8 + 8 + 4 + 8 + 8 + 32 + 8;
}

/// Kept forever as the public record of what each round committed to.
#[account]
pub struct RoundHeader {
    pub distributor: Pubkey,
    pub round_id: u64,
    pub assets_root: [u8; 32],
    /// sha256 of the round's canonical manifest.json.
    pub artifact_hash: [u8; 32],
    pub asset_count: u8,
    pub opened_mask: u32,
    pub closed_mask: u32,
    pub allow_freeze_authority_mask: u32,
    pub committed_ts: i64,
    pub expiry_ts: i64,
    pub window_start_slot: u64,
    pub window_end_slot: u64,
    pub bump: u8,
}

impl RoundHeader {
    pub const SIZE: usize = 8 + 32 + 8 + 32 + 32 + 1 + 4 + 4 + 4 + 8 + 8 + 8 + 8 + 1;
}

/// Callers guarantee `asset_idx < MAX_ASSETS_PER_ROUND`, so this fits a u32.
pub fn asset_bit(asset_idx: u8) -> u32 {
    1u32 << asset_idx
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AssetStatus {
    Pending,
    Active,
}

#[account]
pub struct RoundAsset {
    pub distributor: Pubkey,
    pub round: Pubkey,
    pub round_id: u64,
    pub asset_idx: u8,
    pub status: AssetStatus,
    pub bump: u8,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub vault: Pubkey,
    pub merkle_root: [u8; 32],
    pub allocated: u64,
    pub funded: u64,
    pub claimed: u64,
    pub leaf_count: u32,
    pub bitmap: Vec<u8>,
}

pub fn bitmap_len(leaf_count: u32) -> usize {
    (leaf_count as usize + 7) / 8
}

impl RoundAsset {
    pub fn space(leaf_count: u32) -> usize {
        8 + 32 + 32 + 8 + 1 + 1 + 1 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 4 + 4 + bitmap_len(leaf_count)
    }

    pub fn is_claimed(&self, leaf_idx: u32) -> bool {
        self.bitmap[(leaf_idx / 8) as usize] & (1u8 << (leaf_idx % 8)) != 0
    }

    pub fn set_claimed(&mut self, leaf_idx: u32) {
        self.bitmap[(leaf_idx / 8) as usize] |= 1u8 << (leaf_idx % 8);
    }

    /// Parts of the PDA signer seeds `["round_asset", round, asset_idx, bump]`.
    pub fn signer_seeds_parts(&self) -> (Pubkey, [u8; 1], [u8; 1]) {
        (self.round, [self.asset_idx], [self.bump])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_round_asset_fits_cpi_init_limit() {
        assert!(RoundAsset::space(MAX_LEAVES_PER_ASSET) <= 10_240);
        assert_eq!(bitmap_len(MAX_LEAVES_PER_ASSET), 8_192);
    }

    #[test]
    fn bitmap_len_rounds_up() {
        assert_eq!(bitmap_len(1), 1);
        assert_eq!(bitmap_len(7), 1);
        assert_eq!(bitmap_len(8), 1);
        assert_eq!(bitmap_len(9), 2);
    }

    #[test]
    fn every_asset_index_has_its_own_bit() {
        let mut seen = 0u32;
        for idx in 0..MAX_ASSETS_PER_ROUND {
            assert_eq!(seen & asset_bit(idx), 0);
            seen |= asset_bit(idx);
        }
    }
}
