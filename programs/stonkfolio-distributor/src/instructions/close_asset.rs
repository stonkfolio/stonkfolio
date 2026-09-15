use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_2022::spl_token_2022;

use crate::errors::DistributorError;
use crate::events::AssetClosed;
use crate::state::{asset_bit, Distributor, RoundAsset, RoundHeader};
use crate::token_utils::{
    close_vault, harvest_withheld_to_mint, mint_has_extension, read_mint_decimals, read_token_account,
    transfer_from_vault, EXT_TRANSFER_FEE_CONFIG,
};

pub fn handler(ctx: Context<CloseAsset>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &ctx.accounts;
    let asset = &a.round_asset;
    require_keys_eq!(a.round.key(), asset.round, DistributorError::RoundMismatch);
    require_keys_eq!(a.distributor.key(), asset.distributor, DistributorError::DistributorMismatch);
    require!(now >= a.round.expiry_ts, DistributorError::RoundNotExpired);
    require_keys_eq!(a.token_program.key(), asset.token_program, DistributorError::InvalidTokenProgram);
    require_keys_eq!(a.mint.key(), asset.mint, DistributorError::MintMismatch);
    require_keys_eq!(a.vault.key(), asset.vault, DistributorError::VaultMismatch);
    require_keys_eq!(
        a.rollover_wallet.key(),
        a.distributor.root_authority,
        DistributorError::RolloverMismatch
    );
    let rollover_ata = get_associated_token_address_with_program_id(
        &a.distributor.root_authority,
        &asset.mint,
        &asset.token_program,
    );
    require_keys_eq!(a.rollover_destination.key(), rollover_ata, DistributorError::RolloverMismatch);

    let token_program = a.token_program.to_account_info();
    let mint = a.mint.to_account_info();
    let vault = a.vault.to_account_info();
    let authority = asset.to_account_info();
    let (round_key, asset_idx_bytes, bump_bytes) = asset.signer_seeds_parts();
    let seeds: &[&[u8]] = &[b"round_asset", round_key.as_ref(), &asset_idx_bytes, &bump_bytes];

    // A mint closed after its supply reached zero has nothing left to harvest or return.
    let mint_live = !mint.data_is_empty() && *mint.owner == asset.token_program;
    if mint_live && asset.token_program == spl_token_2022::ID && mint_has_extension(&mint, EXT_TRANSFER_FEE_CONFIG)? {
        harvest_withheld_to_mint(&token_program, &mint, &vault)?;
    }

    let remaining = read_token_account(&vault, &asset.token_program)?.amount;
    if remaining > 0 {
        let rollover = read_token_account(&a.rollover_destination.to_account_info(), &asset.token_program)?;
        require_keys_eq!(rollover.owner, a.distributor.root_authority, DistributorError::RolloverMismatch);
        let decimals = read_mint_decimals(&mint)?;
        transfer_from_vault(
            &token_program,
            &vault,
            &mint,
            &a.rollover_destination.to_account_info(),
            &authority,
            seeds,
            remaining,
            decimals,
        )?;
    }
    close_vault(&token_program, &vault, &a.rollover_wallet.to_account_info(), &authority, seeds)?;

    let distributor = asset.distributor;
    let round_id = asset.round_id;
    let asset_idx = asset.asset_idx;

    let round = &mut ctx.accounts.round;
    round.closed_mask |= asset_bit(asset_idx);

    let rollover_wallet = ctx.accounts.rollover_wallet.to_account_info();
    ctx.accounts.round_asset.close(rollover_wallet)?;

    emit!(AssetClosed {
        distributor,
        round_id,
        asset_idx,
        returned: remaining,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CloseAsset<'info> {
    pub distributor: Box<Account<'info, Distributor>>,

    #[account(mut)]
    pub round: Box<Account<'info, RoundHeader>>,

    #[account(mut)]
    pub round_asset: Box<Account<'info, RoundAsset>>,

    /// CHECK: must equal round_asset.mint.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,

    /// CHECK: must equal round_asset.vault.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: must be the root authority's canonical ATA for this mint.
    #[account(mut)]
    pub rollover_destination: UncheckedAccount<'info>,

    /// CHECK: must equal distributor.root_authority; receives closed-account rent.
    #[account(mut)]
    pub rollover_wallet: UncheckedAccount<'info>,

    /// CHECK: must equal round_asset.token_program.
    pub token_program: UncheckedAccount<'info>,
}
