use anchor_lang::prelude::*;

use crate::errors::DistributorError;
use crate::events::{DistributorCreated, RootAuthorityRotated};
use crate::pyth::sponsored_feed_account;
use crate::state::{Distributor, MAX_MIN_EXPIRY_SECS, MAX_SEED_SLOT_OFFSET};
use crate::token_utils::is_token_program;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateDistributorParams {
    pub min_expiry_secs: i64,
    pub policy_hash: [u8; 32],
    pub price_feed_account: Pubkey,
    pub price_feed_id: [u8; 32],
    pub max_price_age_secs: u32,
    pub max_price_conf_bps: u16,
    pub seed_slot_offset: u16,
    pub min_window_secs: u32,
}

/// Permissionless: anyone can create a distributor for any mint, but only
/// under their own key (it is part of the PDA seeds). Holders and the
/// launchpad UI decide which distributor is the coin's official one by its
/// address, not by any on-chain registry an admin could edit.
pub fn create_distributor(ctx: Context<CreateDistributor>, params: CreateDistributorParams) -> Result<()> {
    require!(is_token_program(ctx.accounts.index_mint.owner), DistributorError::InvalidAccountData);
    require!(
        params.min_expiry_secs >= 0 && params.min_expiry_secs <= MAX_MIN_EXPIRY_SECS,
        DistributorError::InvalidConfig
    );
    require!(
        params.seed_slot_offset >= 1 && params.seed_slot_offset <= MAX_SEED_SLOT_OFFSET,
        DistributorError::InvalidConfig
    );
    require_keys_eq!(
        params.price_feed_account,
        sponsored_feed_account(&params.price_feed_id),
        DistributorError::NotPythFeedAccount
    );
    require!(params.max_price_age_secs >= 1, DistributorError::InvalidConfig);
    require!(
        params.max_price_conf_bps >= 1 && params.max_price_conf_bps <= 10_000,
        DistributorError::InvalidConfig
    );

    let root_authority = ctx.accounts.root_authority.key();
    let distributor = &mut ctx.accounts.distributor;
    distributor.index_mint = ctx.accounts.index_mint.key();
    distributor.creator = root_authority;
    distributor.root_authority = root_authority;
    distributor.pending_root_authority = None;
    distributor.min_expiry_secs = params.min_expiry_secs;
    distributor.next_round_id = 0;
    distributor.bump = ctx.bumps.distributor;
    distributor.policy_hash = params.policy_hash;
    distributor.price_feed_account = params.price_feed_account;
    distributor.price_feed_id = params.price_feed_id;
    distributor.max_price_age_secs = params.max_price_age_secs;
    distributor.max_price_conf_bps = params.max_price_conf_bps;
    distributor.seed_slot_offset = params.seed_slot_offset;
    distributor.min_window_secs = params.min_window_secs;
    distributor.expired_seed_abandons = 0;

    emit!(DistributorCreated {
        distributor: distributor.key(),
        index_mint: distributor.index_mint,
        root_authority,
        min_expiry_secs: params.min_expiry_secs,
        policy_hash: params.policy_hash,
    });
    Ok(())
}

/// The keeper is the only key with any power over its distributor, so it is
/// also the only key that can hand that power to a replacement (e.g. rotating
/// a server key). Two-step so a mistyped key can't strand the distributor.
pub fn propose_root_authority(ctx: Context<ProposeRootAuthority>, new_root_authority: Pubkey) -> Result<()> {
    let distributor = &mut ctx.accounts.distributor;
    require_keys_eq!(
        ctx.accounts.root_authority.key(),
        distributor.root_authority,
        DistributorError::Unauthorized
    );
    // A default or unchanged key could never complete a rotation, but it would overwrite a real pending proposal.
    require!(
        new_root_authority != Pubkey::default() && new_root_authority != distributor.root_authority,
        DistributorError::InvalidRootAuthority
    );
    distributor.pending_root_authority = Some(new_root_authority);
    Ok(())
}

pub fn accept_root_authority(ctx: Context<AcceptRootAuthority>) -> Result<()> {
    let distributor = &mut ctx.accounts.distributor;
    let new_root_authority = ctx.accounts.new_root_authority.key();
    require!(
        distributor.pending_root_authority == Some(new_root_authority),
        DistributorError::NoPendingRootAuthority
    );
    let previous = distributor.root_authority;
    distributor.root_authority = new_root_authority;
    distributor.pending_root_authority = None;
    emit!(RootAuthorityRotated {
        distributor: distributor.key(),
        previous,
        new: new_root_authority,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CreateDistributor<'info> {
    pub root_authority: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: must be owned by spl-token or spl-token-2022 (checked in the handler).
    pub index_mint: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = Distributor::SIZE,
        seeds = [b"distributor", index_mint.key().as_ref(), root_authority.key().as_ref()],
        bump,
    )]
    pub distributor: Box<Account<'info, Distributor>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProposeRootAuthority<'info> {
    pub root_authority: Signer<'info>,

    #[account(mut)]
    pub distributor: Box<Account<'info, Distributor>>,
}

#[derive(Accounts)]
pub struct AcceptRootAuthority<'info> {
    pub new_root_authority: Signer<'info>,

    #[account(mut)]
    pub distributor: Box<Account<'info, Distributor>>,
}
