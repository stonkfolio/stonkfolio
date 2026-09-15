use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;

use crate::errors::DistributorError;
use crate::events::ExcessSwept;
use crate::state::{AssetStatus, Distributor, RoundAsset};
use crate::token_utils::{read_mint_decimals, read_token_account, transfer_from_vault};

pub fn handler(ctx: Context<SweepExcess>) -> Result<()> {
    let a = &ctx.accounts;
    let asset = &a.round_asset;
    require_keys_eq!(a.distributor.key(), asset.distributor, DistributorError::DistributorMismatch);
    require!(asset.status == AssetStatus::Active, DistributorError::InvalidStatus);
    require_keys_eq!(a.token_program.key(), asset.token_program, DistributorError::InvalidTokenProgram);
    require_keys_eq!(a.mint.key(), asset.mint, DistributorError::MintMismatch);
    require_keys_eq!(a.vault.key(), asset.vault, DistributorError::VaultMismatch);

    let rollover_ata = get_associated_token_address_with_program_id(
        &a.distributor.root_authority,
        &asset.mint,
        &asset.token_program,
    );
    require_keys_eq!(a.rollover_destination.key(), rollover_ata, DistributorError::RolloverMismatch);

    let rollover = read_token_account(&a.rollover_destination.to_account_info(), &asset.token_program)?;
    require_keys_eq!(rollover.owner, a.distributor.root_authority, DistributorError::RolloverMismatch);

    let vault = read_token_account(&a.vault.to_account_info(), &asset.token_program)?;
    // Everything allocated but not yet paid stays reserved for recipients.
    let reserved = asset.allocated.checked_sub(asset.claimed).ok_or(DistributorError::Overflow)?;
    let excess = vault.amount.saturating_sub(reserved);
    require!(excess > 0, DistributorError::NothingToSweep);

    let decimals = read_mint_decimals(&a.mint.to_account_info())?;
    let (round_key, asset_idx_bytes, bump_bytes) = asset.signer_seeds_parts();
    let seeds: &[&[u8]] = &[b"round_asset", round_key.as_ref(), &asset_idx_bytes, &bump_bytes];
    transfer_from_vault(
        &a.token_program.to_account_info(),
        &a.vault.to_account_info(),
        &a.mint.to_account_info(),
        &a.rollover_destination.to_account_info(),
        &asset.to_account_info(),
        seeds,
        excess,
        decimals,
    )?;

    emit!(ExcessSwept {
        distributor: asset.distributor,
        round_id: asset.round_id,
        asset_idx: asset.asset_idx,
        amount: excess,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SweepExcess<'info> {
    pub distributor: Box<Account<'info, Distributor>>,

    pub round_asset: Box<Account<'info, RoundAsset>>,

    /// CHECK: must equal round_asset.mint.
    pub mint: UncheckedAccount<'info>,

    /// CHECK: must equal round_asset.vault.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: must be the root authority's canonical ATA for this mint.
    #[account(mut)]
    pub rollover_destination: UncheckedAccount<'info>,

    /// CHECK: must equal round_asset.token_program.
    pub token_program: UncheckedAccount<'info>,
}
