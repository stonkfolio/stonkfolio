use anchor_lang::prelude::*;
use anchor_spl::associated_token::{self, get_associated_token_address_with_program_id, AssociatedToken};

use crate::errors::DistributorError;
use crate::events::AssetOpened;
use crate::merkle::{self, MAX_PROOF_LEN};
use crate::state::{asset_bit, bitmap_len, AssetStatus, RoundAsset, RoundHeader, MAX_LEAVES_PER_ASSET};
use crate::token_utils::vet_mint;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OpenAssetParams {
    pub asset_idx: u8,
    pub merkle_root: [u8; 32],
    pub allocated: u64,
    pub leaf_count: u32,
    pub asset_proof: Vec<[u8; 32]>,
}

pub fn handler(ctx: Context<OpenAsset>, params: OpenAssetParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let round_key = ctx.accounts.round.key();

    let round = &mut ctx.accounts.round;
    require!(now < round.expiry_ts, DistributorError::RoundExpired);
    require!(params.asset_idx < round.asset_count, DistributorError::AssetIndexOutOfRange);
    let bit = asset_bit(params.asset_idx);
    // Once opened, never again — so an asset can't come back with a fresh
    // claim bitmap and pay the same leaves twice.
    require!(round.opened_mask & bit == 0, DistributorError::AssetAlreadyOpened);
    require!(
        params.leaf_count >= 1 && params.leaf_count <= MAX_LEAVES_PER_ASSET,
        DistributorError::InvalidLeafCount
    );
    require!(params.allocated > 0, DistributorError::InvalidAllocation);
    require!(params.asset_proof.len() <= MAX_PROOF_LEN, DistributorError::ProofTooLong);

    let distributor = round.distributor;
    let round_id = round.round_id;
    let mint_key = ctx.accounts.mint.key();
    let token_program_key = ctx.accounts.token_program.key();
    let leaf = merkle::asset_leaf(
        &crate::ID,
        &distributor,
        round_id,
        params.asset_idx,
        &mint_key,
        &token_program_key,
        &params.merkle_root,
        params.allocated,
        params.leaf_count,
    );
    require!(
        merkle::verify(&params.asset_proof, &round.assets_root, leaf),
        DistributorError::InvalidAssetProof
    );

    vet_mint(
        &ctx.accounts.mint.to_account_info(),
        &token_program_key,
        round.allow_freeze_authority_mask & bit != 0,
    )?;
    round.opened_mask |= bit;

    let round_asset_key = ctx.accounts.round_asset.key();
    let expected_vault = get_associated_token_address_with_program_id(&round_asset_key, &mint_key, &token_program_key);
    require_keys_eq!(ctx.accounts.vault.key(), expected_vault, DistributorError::VaultMismatch);

    // Idempotent: ATA creation is permissionless, so anyone could pre-create
    // this vault to block a non-idempotent create. A pre-created ATA is still
    // owned by the round_asset PDA and is exactly the account we want.
    associated_token::create_idempotent(CpiContext::new(
        ctx.accounts.associated_token_program.to_account_info(),
        associated_token::Create {
            payer: ctx.accounts.payer.to_account_info(),
            associated_token: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.round_asset.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        },
    ))?;

    let asset = &mut ctx.accounts.round_asset;
    asset.distributor = distributor;
    asset.round = round_key;
    asset.round_id = round_id;
    asset.asset_idx = params.asset_idx;
    asset.status = AssetStatus::Pending;
    asset.bump = ctx.bumps.round_asset;
    asset.mint = mint_key;
    asset.token_program = token_program_key;
    asset.vault = expected_vault;
    asset.merkle_root = params.merkle_root;
    asset.allocated = params.allocated;
    asset.funded = 0;
    asset.claimed = 0;
    asset.leaf_count = params.leaf_count;
    asset.bitmap = vec![0u8; bitmap_len(params.leaf_count)];

    emit!(AssetOpened {
        distributor,
        round_id,
        asset_idx: params.asset_idx,
        mint: mint_key,
        vault: expected_vault,
        allocated: params.allocated,
        leaf_count: params.leaf_count,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(params: OpenAssetParams)]
pub struct OpenAsset<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub round: Box<Account<'info, RoundHeader>>,

    #[account(
        init,
        payer = payer,
        space = RoundAsset::space(params.leaf_count),
        seeds = [b"round_asset", round.key().as_ref(), params.asset_idx.to_le_bytes().as_ref()],
        bump,
    )]
    pub round_asset: Box<Account<'info, RoundAsset>>,

    /// CHECK: owner, initialization and extensions vetted in the handler.
    pub mint: UncheckedAccount<'info>,

    /// CHECK: must equal the round_asset's canonical ATA; created in the handler.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: must be spl-token or spl-token-2022 and own the mint (vet_mint).
    pub token_program: UncheckedAccount<'info>,

    pub associated_token_program: Program<'info, AssociatedToken>,

    pub system_program: Program<'info, System>,
}
