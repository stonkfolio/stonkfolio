//! Stonkfolio round distributor — one `Distributor` per launched index coin.
//!
//! Each round commits one `assets_root` over up to 30 basket assets; each
//! asset carries its own Merkle root over `(leaf_idx, recipient, amount)`
//! payouts. Committing a root does NOT prove the allocation behind it was
//! computed correctly — that is what the published round artifacts and
//! `scripts/verify-round.ts` are for. What this program enforces:
//!
//! - sampling can't be gamed by the keeper: the secret is committed before
//!   snapshots, the window and SOL/USD price are recorded by the program at
//!   close, the seed block is picked by the program, and a seeded round can't
//!   be discarded
//! - the round policy (eligibility threshold, exclusions, sample counts) is
//!   fixed per distributor by hash
//! - a payout only reaches the committed recipient, each leaf pays at most
//!   once, total payouts never exceed the committed allocation, and unclaimed
//!   funds only leave after expiry
//!
//! There are no dev controls: no global admin, no pause, no cancel. Each
//! distributor's only authority is its automated keeper (`root_authority`).
//! The upgrade authority is meant to be revoked after audit.
use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod merkle;
pub mod pyth;
pub mod slot_hashes;
pub mod state;
pub mod token_utils;

use instructions::*;

declare_id!("C4mQLDEnnFupVCwQbr9Bzygr9kJaowRTmmUEb9FoFaLh");

#[program]
pub mod stonkfolio_distributor {
    use super::*;

    /// Permissionless: creates a distributor for an index coin under the signer's key, fixing its round policy.
    pub fn create_distributor(ctx: Context<CreateDistributor>, params: CreateDistributorParams) -> Result<()> {
        instructions::distributor::create_distributor(ctx, params)
    }

    /// Current keeper key proposes its replacement.
    pub fn propose_root_authority(ctx: Context<ProposeRootAuthority>, new_root_authority: Pubkey) -> Result<()> {
        instructions::distributor::propose_root_authority(ctx, new_root_authority)
    }

    /// Proposed keeper key accepts, completing the handoff.
    pub fn accept_root_authority(ctx: Context<AcceptRootAuthority>) -> Result<()> {
        instructions::distributor::accept_root_authority(ctx)
    }

    /// Keeper commits sha256(secret) for the next round before taking snapshots.
    pub fn open_round(ctx: Context<OpenRound>, round_id: u64, secret_commitment: [u8; 32]) -> Result<()> {
        instructions::round_intent::open_round(ctx, round_id, secret_commitment)
    }

    /// Keeper closes the window; the program records the snapshot chain head and Pyth SOL/USD.
    pub fn close_window(ctx: Context<CloseWindow>, snapshot_chain_head: [u8; 32], snapshot_count: u32) -> Result<()> {
        instructions::round_intent::close_window(ctx, snapshot_chain_head, snapshot_count)
    }

    /// Permissionless: records the seed block hash once it exists.
    pub fn record_seed(ctx: Context<RecordSeed>) -> Result<()> {
        instructions::round_intent::record_seed(ctx)
    }

    /// Keeper abandons a round that never got a seed (before close, or after the seed aged out).
    pub fn abandon_round(ctx: Context<AbandonRound>) -> Result<()> {
        instructions::round_intent::abandon_round(ctx)
    }

    /// Keeper reveals the secret and commits the round's asset tree.
    pub fn commit_round(ctx: Context<CommitRound>, params: CommitRoundParams) -> Result<()> {
        instructions::commit_round::handler(ctx, params)
    }

    /// Permissionless: proves one asset tuple against the round's root,
    /// vets the mint, and creates the asset's vault.
    pub fn open_asset(ctx: Context<OpenAsset>, params: OpenAssetParams) -> Result<()> {
        instructions::open_asset::handler(ctx, params)
    }

    /// Permissionless: marks an asset payable once its vault covers the allocation.
    pub fn activate_asset(ctx: Context<ActivateAsset>) -> Result<()> {
        instructions::activate_asset::handler(ctx)
    }

    /// Permissionless push to the recipient's canonical ATA. The recipient
    /// does not sign; the destination is pinned to them.
    pub fn push_payout(ctx: Context<PushPayout>, leaf_idx: u32, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        instructions::payout::push_payout(ctx, leaf_idx, amount, proof)
    }

    /// Permissionless batched push: pays the `Push` leaves of one aligned block
    /// (up to 32 leaves) with a single proof, each into its recipient's
    /// canonical ATA. Leaves already paid are skipped.
    pub fn push_payouts<'info>(ctx: Context<'_, '_, 'info, 'info, PushPayouts<'info>>, params: PushPayoutsParams) -> Result<()> {
        instructions::payout::push_payouts(ctx, params)
    }

    /// Recipient-signed claim into any token account the recipient owns —
    /// the fallback when a push can't land (memo-required, frozen, etc.).
    pub fn self_claim(ctx: Context<SelfClaim>, leaf_idx: u32, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        instructions::payout::self_claim(ctx, leaf_idx, amount, proof)
    }

    /// Permissionless: returns vault balance above what is still owed to the
    /// keeper, which rolls it into the next round.
    pub fn sweep_excess(ctx: Context<SweepExcess>) -> Result<()> {
        instructions::sweep_excess::handler(ctx)
    }

    /// Permissionless after expiry: returns everything left to the keeper for
    /// the next round and closes the asset's accounts.
    pub fn close_asset(ctx: Context<CloseAsset>) -> Result<()> {
        instructions::close_asset::handler(ctx)
    }
}
