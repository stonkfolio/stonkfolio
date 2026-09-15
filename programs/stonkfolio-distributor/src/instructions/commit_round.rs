use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;

use crate::errors::DistributorError;
use crate::events::RoundCommitted;
use crate::state::{Distributor, IntentStatus, RoundHeader, RoundIntent, MAX_ASSETS_PER_ROUND};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CommitRoundParams {
    pub round_id: u64,
    /// Revealed sampling secret; must hash to the intent's commitment.
    pub secret: [u8; 32],
    pub assets_root: [u8; 32],
    pub artifact_hash: [u8; 32],
    /// Zero is allowed: a seeded round with nothing to pay still gets committed.
    pub asset_count: u8,
    pub expiry_ts: i64,
    pub allow_freeze_authority_mask: u32,
}

pub fn handler(ctx: Context<CommitRound>, params: CommitRoundParams) -> Result<()> {
    let distributor_key = ctx.accounts.distributor.key();
    let distributor = &mut ctx.accounts.distributor;
    require_keys_eq!(
        ctx.accounts.root_authority.key(),
        distributor.root_authority,
        DistributorError::Unauthorized
    );
    require!(params.round_id == distributor.next_round_id, DistributorError::InvalidRoundId);

    let intent = &mut ctx.accounts.intent;
    require_keys_eq!(intent.distributor, distributor_key, DistributorError::IntentMismatch);
    require!(intent.round_id == params.round_id, DistributorError::IntentMismatch);
    require!(intent.status == IntentStatus::Seeded, DistributorError::InvalidIntentStatus);
    require!(
        hashv(&[&params.secret]).to_bytes() == intent.secret_commitment,
        DistributorError::SecretMismatch
    );

    require!(params.asset_count <= MAX_ASSETS_PER_ROUND, DistributorError::InvalidAssetCount);
    // asset_count <= 30, so the mask fits a u32.
    let valid_mask = ((1u64 << params.asset_count) - 1) as u32;
    require!(
        params.allow_freeze_authority_mask & !valid_mask == 0,
        DistributorError::InvalidAllowMask
    );

    let now = Clock::get()?.unix_timestamp;
    let min_expiry = now
        .checked_add(distributor.min_expiry_secs)
        .ok_or(DistributorError::Overflow)?;
    require!(
        params.expiry_ts >= min_expiry && params.expiry_ts > now,
        DistributorError::ExpiryTooSoon
    );

    distributor.next_round_id = distributor
        .next_round_id
        .checked_add(1)
        .ok_or(DistributorError::Overflow)?;
    intent.status = IntentStatus::Committed;

    let round = &mut ctx.accounts.round;
    round.distributor = distributor_key;
    round.round_id = params.round_id;
    round.assets_root = params.assets_root;
    round.artifact_hash = params.artifact_hash;
    round.asset_count = params.asset_count;
    round.opened_mask = 0;
    round.closed_mask = 0;
    round.allow_freeze_authority_mask = params.allow_freeze_authority_mask;
    round.committed_ts = now;
    round.expiry_ts = params.expiry_ts;
    round.window_start_slot = intent.open_slot;
    round.window_end_slot = intent.close_slot;
    round.bump = ctx.bumps.round;

    emit!(RoundCommitted {
        distributor: distributor_key,
        round_id: round.round_id,
        assets_root: round.assets_root,
        artifact_hash: round.artifact_hash,
        asset_count: round.asset_count,
        expiry_ts: round.expiry_ts,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(params: CommitRoundParams)]
pub struct CommitRound<'info> {
    pub root_authority: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub distributor: Box<Account<'info, Distributor>>,

    #[account(mut)]
    pub intent: Box<Account<'info, RoundIntent>>,

    #[account(
        init,
        payer = payer,
        space = RoundHeader::SIZE,
        seeds = [b"round", distributor.key().as_ref(), params.round_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub round: Box<Account<'info, RoundHeader>>,

    pub system_program: Program<'info, System>,
}
