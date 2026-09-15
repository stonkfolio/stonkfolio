use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;

use crate::errors::DistributorError;
use crate::events::PayoutEvent;
use crate::merkle::{self, MAX_PROOF_LEN};
use crate::state::{AssetStatus, RoundAsset, RoundHeader};
use crate::token_utils::{read_mint_decimals, read_token_account, transfer_from_vault};

struct PayoutAccounts<'a, 'info> {
    round: &'a Account<'info, RoundHeader>,
    round_asset: &'a mut Account<'info, RoundAsset>,
    mint: AccountInfo<'info>,
    vault: AccountInfo<'info>,
    recipient: Pubkey,
    destination: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
}

fn process(accounts: PayoutAccounts, leaf_idx: u32, amount: u64, proof: Vec<[u8; 32]>, self_claim: bool) -> Result<()> {
    let PayoutAccounts { round, round_asset: asset, mint, vault, recipient, destination, token_program } = accounts;
    let now = Clock::get()?.unix_timestamp;

    require_keys_eq!(round.key(), asset.round, DistributorError::RoundMismatch);
    require!(asset.status == AssetStatus::Active, DistributorError::InvalidStatus);
    require!(now < round.expiry_ts, DistributorError::RoundExpired);

    require_keys_eq!(token_program.key(), asset.token_program, DistributorError::InvalidTokenProgram);
    require_keys_eq!(mint.key(), asset.mint, DistributorError::MintMismatch);
    require_keys_eq!(vault.key(), asset.vault, DistributorError::VaultMismatch);

    require!(leaf_idx < asset.leaf_count, DistributorError::LeafIndexOutOfRange);
    require!(!asset.is_claimed(leaf_idx), DistributorError::AlreadyClaimed);
    require!(amount > 0, DistributorError::ZeroAmount);
    require!(proof.len() <= MAX_PROOF_LEN, DistributorError::ProofTooLong);
    let leaf = merkle::payout_leaf(
        &crate::ID,
        &asset.distributor,
        asset.round_id,
        asset.asset_idx,
        leaf_idx,
        &recipient,
        amount,
    );
    require!(merkle::verify(&proof, &asset.merkle_root, leaf), DistributorError::InvalidProof);

    let claimed = asset.claimed.checked_add(amount).ok_or(DistributorError::Overflow)?;
    require!(claimed <= asset.allocated, DistributorError::ExceedsAllocation);

    // Both checks matter for pushes: the address pins the canonical ATA, and
    // the owner field catches a legacy spl-token ATA whose owner was changed
    // with SetAuthority after creation.
    if !self_claim {
        let canonical = get_associated_token_address_with_program_id(&recipient, &asset.mint, &asset.token_program);
        require_keys_eq!(destination.key(), canonical, DistributorError::DestinationNotCanonicalAta);
    }
    let dest = read_token_account(&destination, &asset.token_program)?;
    require_keys_eq!(dest.mint, asset.mint, DistributorError::MintMismatch);
    require_keys_eq!(dest.owner, recipient, DistributorError::ClaimDestinationMismatch);
    // A leaf naming the asset account itself would "pay" the vault into itself: claimed rises, no tokens
    // leave, and sweep_excess could then take them. Only a bad tree can do this; refuse it anyway.
    require!(
        destination.key() != asset.vault && recipient != asset.key(),
        DistributorError::DestinationIsVault
    );

    asset.set_claimed(leaf_idx);
    asset.claimed = claimed;

    let decimals = read_mint_decimals(&mint)?;
    let authority = asset.to_account_info();
    let (round_key, asset_idx_bytes, bump_bytes) = asset.signer_seeds_parts();
    let seeds: &[&[u8]] = &[b"round_asset", round_key.as_ref(), &asset_idx_bytes, &bump_bytes];
    transfer_from_vault(&token_program, &vault, &mint, &destination, &authority, seeds, amount, decimals)?;

    emit!(PayoutEvent {
        distributor: asset.distributor,
        round_id: asset.round_id,
        asset_idx: asset.asset_idx,
        leaf_idx,
        recipient,
        destination: destination.key(),
        amount,
        self_claim,
    });
    Ok(())
}

pub fn push_payout(ctx: Context<PushPayout>, leaf_idx: u32, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
    let a = ctx.accounts;
    process(
        PayoutAccounts {
            round: &a.round,
            round_asset: &mut a.round_asset,
            mint: a.mint.to_account_info(),
            vault: a.vault.to_account_info(),
            recipient: a.recipient.key(),
            destination: a.destination.to_account_info(),
            token_program: a.token_program.to_account_info(),
        },
        leaf_idx,
        amount,
        proof,
        false,
    )
}

pub fn self_claim(ctx: Context<SelfClaim>, leaf_idx: u32, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
    let a = ctx.accounts;
    process(
        PayoutAccounts {
            round: &a.round,
            round_asset: &mut a.round_asset,
            mint: a.mint.to_account_info(),
            vault: a.vault.to_account_info(),
            recipient: a.recipient.key(),
            destination: a.destination.to_account_info(),
            token_program: a.token_program.to_account_info(),
        },
        leaf_idx,
        amount,
        proof,
        true,
    )
}

/// Largest block `push_payouts` accepts: 2^5 = 32 leaves.
pub const MAX_BLOCK_LEVEL: u8 = 5;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum BlockLeaf {
    /// Pay this leaf into the next destination account passed; its recipient is that account's owner.
    Push { amount: u64 },
    /// Don't pay this leaf now (already paid, or left for self-claim); it is only hashed.
    Skip { recipient: Pubkey, amount: u64 },
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PushPayoutsParams {
    /// First leaf of the block; must be a multiple of 2^level.
    pub first_leaf: u32,
    pub level: u8,
    /// Every leaf in the block, in order.
    pub leaves: Vec<BlockLeaf>,
    /// Siblings of the block's subtree root on the way up to the asset root.
    pub proof: Vec<[u8; 32]>,
}

/// Pushes many payouts of one asset with a single proof. The destinations of
/// `Push` leaves come as remaining accounts, in leaf order. Every guarantee of
/// `push_payout` holds: each pushed leaf goes only to its recipient's
/// canonical token account, pays once, and stays within the allocation.
pub fn push_payouts<'info>(ctx: Context<'_, '_, 'info, 'info, PushPayouts<'info>>, params: PushPayoutsParams) -> Result<()> {
    let destinations = ctx.remaining_accounts;
    let a = ctx.accounts;
    let now = Clock::get()?.unix_timestamp;
    let asset = &mut a.round_asset;

    require_keys_eq!(a.round.key(), asset.round, DistributorError::RoundMismatch);
    require!(asset.status == AssetStatus::Active, DistributorError::InvalidStatus);
    require!(now < a.round.expiry_ts, DistributorError::RoundExpired);
    require_keys_eq!(a.token_program.key(), asset.token_program, DistributorError::InvalidTokenProgram);
    require_keys_eq!(a.mint.key(), asset.mint, DistributorError::MintMismatch);
    require_keys_eq!(a.vault.key(), asset.vault, DistributorError::VaultMismatch);

    require!(params.level <= MAX_BLOCK_LEVEL, DistributorError::InvalidBlock);
    require!(params.proof.len() <= MAX_PROOF_LEN, DistributorError::ProofTooLong);
    let block_size = 1u32 << params.level;
    require!(
        params.first_leaf < asset.leaf_count && params.first_leaf % block_size == 0,
        DistributorError::InvalidBlock
    );
    let expected = block_size.min(asset.leaf_count - params.first_leaf) as usize;
    require!(params.leaves.len() == expected, DistributorError::InvalidBlock);

    let mut hashes = Vec::with_capacity(expected);
    let mut pushes: Vec<(u32, u64, Pubkey, &AccountInfo<'info>)> = Vec::new();
    for (offset, leaf) in params.leaves.iter().enumerate() {
        let leaf_idx = params.first_leaf + offset as u32;
        let (recipient, amount) = match leaf {
            BlockLeaf::Push { amount } => {
                let destination = destinations.get(pushes.len()).ok_or(DistributorError::InvalidBlock)?;
                let view = read_token_account(destination, &asset.token_program)?;
                require_keys_eq!(view.mint, asset.mint, DistributorError::MintMismatch);
                // The recipient is the destination's owner. The leaf hash proves that owner is the
                // committed recipient; the address check rules out any account but their canonical ATA.
                let canonical = get_associated_token_address_with_program_id(&view.owner, &asset.mint, &asset.token_program);
                require_keys_eq!(destination.key(), canonical, DistributorError::DestinationNotCanonicalAta);
                // Same guard as process(): never a vault-to-vault "payout".
                require!(
                    destination.key() != asset.vault && view.owner != asset.key(),
                    DistributorError::DestinationIsVault
                );
                require!(*amount > 0, DistributorError::ZeroAmount);
                pushes.push((leaf_idx, *amount, view.owner, destination));
                (view.owner, *amount)
            }
            BlockLeaf::Skip { recipient, amount } => (*recipient, *amount),
        };
        hashes.push(merkle::payout_leaf(
            &crate::ID,
            &asset.distributor,
            asset.round_id,
            asset.asset_idx,
            leaf_idx,
            &recipient,
            amount,
        ));
    }
    require!(pushes.len() == destinations.len(), DistributorError::InvalidBlock);
    require!(
        merkle::verify_block(&hashes, params.first_leaf, params.level, asset.leaf_count, &params.proof, &asset.merkle_root),
        DistributorError::InvalidProof
    );

    let mint = a.mint.to_account_info();
    let vault = a.vault.to_account_info();
    let token_program = a.token_program.to_account_info();
    let decimals = read_mint_decimals(&mint)?;
    let (round_key, asset_idx_bytes, bump_bytes) = asset.signer_seeds_parts();
    for (leaf_idx, amount, recipient, destination) in pushes {
        // Already paid by an earlier push or a self-claim: skipped, so retrying a block is harmless.
        if asset.is_claimed(leaf_idx) {
            continue;
        }
        let claimed = asset.claimed.checked_add(amount).ok_or(DistributorError::Overflow)?;
        require!(claimed <= asset.allocated, DistributorError::ExceedsAllocation);
        asset.set_claimed(leaf_idx);
        asset.claimed = claimed;

        let authority = asset.to_account_info();
        let seeds: &[&[u8]] = &[b"round_asset", round_key.as_ref(), &asset_idx_bytes, &bump_bytes];
        transfer_from_vault(&token_program, &vault, &mint, destination, &authority, seeds, amount, decimals)?;
        emit!(PayoutEvent {
            distributor: asset.distributor,
            round_id: asset.round_id,
            asset_idx: asset.asset_idx,
            leaf_idx,
            recipient,
            destination: destination.key(),
            amount,
            self_claim: false,
        });
    }
    Ok(())
}

#[derive(Accounts)]
pub struct PushPayouts<'info> {
    /// Anyone may pay for pushes; amounts and destinations are fixed by the root.
    pub payer: Signer<'info>,

    pub round: Box<Account<'info, RoundHeader>>,

    #[account(mut)]
    pub round_asset: Box<Account<'info, RoundAsset>>,

    /// CHECK: must equal round_asset.mint.
    pub mint: UncheckedAccount<'info>,

    /// CHECK: must equal round_asset.vault.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: must equal round_asset.token_program.
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PushPayout<'info> {
    /// Anyone may pay for a push; amounts and destinations are fixed by the root.
    pub payer: Signer<'info>,

    pub round: Box<Account<'info, RoundHeader>>,

    #[account(mut)]
    pub round_asset: Box<Account<'info, RoundAsset>>,

    /// CHECK: must equal round_asset.mint.
    pub mint: UncheckedAccount<'info>,

    /// CHECK: must equal round_asset.vault.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: bound by the Merkle leaf; not required to sign.
    pub recipient: UncheckedAccount<'info>,

    /// CHECK: must be the recipient's canonical ATA and owned by the recipient.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    /// CHECK: must equal round_asset.token_program.
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SelfClaim<'info> {
    pub round: Box<Account<'info, RoundHeader>>,

    #[account(mut)]
    pub round_asset: Box<Account<'info, RoundAsset>>,

    /// CHECK: must equal round_asset.mint.
    pub mint: UncheckedAccount<'info>,

    /// CHECK: must equal round_asset.vault.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,

    pub recipient: Signer<'info>,

    /// CHECK: any token account for this mint owned by the recipient.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    /// CHECK: must equal round_asset.token_program.
    pub token_program: UncheckedAccount<'info>,
}
