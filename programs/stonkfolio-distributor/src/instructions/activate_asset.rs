use anchor_lang::prelude::*;

use crate::errors::DistributorError;
use crate::events::AssetActivated;
use crate::state::{AssetStatus, RoundAsset, RoundHeader};
use crate::token_utils::read_token_account;

pub fn handler(ctx: Context<ActivateAsset>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let round_key = ctx.accounts.round.key();
    let round = &ctx.accounts.round;
    let asset = &mut ctx.accounts.round_asset;
    require_keys_eq!(round_key, asset.round, DistributorError::RoundMismatch);
    require!(now < round.expiry_ts, DistributorError::RoundExpired);
    require!(asset.status == AssetStatus::Pending, DistributorError::InvalidStatus);
    require_keys_eq!(ctx.accounts.vault.key(), asset.vault, DistributorError::VaultMismatch);

    // Measured, not declared: for transfer-fee mints the vault holds less than
    // the keeper sent, and only what actually arrived can back payouts.
    let vault = read_token_account(&ctx.accounts.vault.to_account_info(), &asset.token_program)?;
    require_keys_eq!(vault.mint, asset.mint, DistributorError::MintMismatch);
    require!(vault.amount >= asset.allocated, DistributorError::Underfunded);

    asset.funded = vault.amount;
    asset.status = AssetStatus::Active;

    emit!(AssetActivated {
        distributor: asset.distributor,
        round_id: asset.round_id,
        asset_idx: asset.asset_idx,
        funded: vault.amount,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ActivateAsset<'info> {
    pub round: Box<Account<'info, RoundHeader>>,

    #[account(mut)]
    pub round_asset: Box<Account<'info, RoundAsset>>,

    /// CHECK: must equal round_asset.vault; read in the handler.
    pub vault: UncheckedAccount<'info>,
}
