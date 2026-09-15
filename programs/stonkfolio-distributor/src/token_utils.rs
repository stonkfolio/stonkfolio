//! Raw token-account and mint parsing. Deliberately does not depend on
//! `spl_token_2022`'s `ExtensionType` enum: the pinned 3.0.5 crate predates
//! newer extensions (e.g. Pausable, ScaledUiAmount), and an enum parse would
//! error on those instead of letting us reject them explicitly. Instead mint
//! extensions are walked as TLV entries against an allow-list, so anything
//! unknown is rejected by default.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_spl::token_2022::spl_token_2022;

use crate::errors::DistributorError;
use crate::state::MAX_TRANSFER_FEE_BPS;

pub const MINT_BASE_LEN: usize = 82;
pub const TOKEN_ACCOUNT_BASE_LEN: usize = 165;
const ACCOUNT_TYPE_MINT: u8 = 1;
const ACCOUNT_TYPE_ACCOUNT: u8 = 2;
const MULTISIG_LEN: usize = 355;
const ACCOUNT_STATE_UNINITIALIZED: u8 = 0;
const ACCOUNT_STATE_FROZEN: u8 = 2;

// Token-2022 ExtensionType discriminants (u16, declaration order).
pub const EXT_UNINITIALIZED: u16 = 0;
pub const EXT_TRANSFER_FEE_CONFIG: u16 = 1;
pub const EXT_MINT_CLOSE_AUTHORITY: u16 = 3;
pub const EXT_DEFAULT_ACCOUNT_STATE: u16 = 6;
pub const EXT_INTEREST_BEARING_CONFIG: u16 = 10;
pub const EXT_TRANSFER_HOOK: u16 = 14;
pub const EXT_METADATA_POINTER: u16 = 18;
pub const EXT_TOKEN_METADATA: u16 = 19;
pub const EXT_GROUP_POINTER: u16 = 20;
pub const EXT_TOKEN_GROUP: u16 = 21;
pub const EXT_GROUP_MEMBER_POINTER: u16 = 22;
pub const EXT_TOKEN_GROUP_MEMBER: u16 = 23;

pub fn is_token_program(key: &Pubkey) -> bool {
    *key == anchor_spl::token::ID || *key == spl_token_2022::ID
}

pub struct TokenAccountView {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

/// Reads an initialized token account owned by `token_program`. spl-token and
/// Token-2022 share the same 165-byte base layout: mint(32) owner(32)
/// amount(8) delegate(36) state(1) ...
pub fn read_token_account(ai: &AccountInfo, token_program: &Pubkey) -> Result<TokenAccountView> {
    require_keys_eq!(*ai.owner, *token_program, DistributorError::InvalidTokenProgram);
    let data = ai.try_borrow_data()?;
    require!(data.len() >= TOKEN_ACCOUNT_BASE_LEN, DistributorError::InvalidAccountData);
    // Legacy token accounts are exactly 165 bytes; extended ones carry account
    // type 2 at byte 165. Mints (type 1) and 355-byte multisigs are rejected.
    require!(data.len() != MULTISIG_LEN, DistributorError::InvalidAccountData);
    if data.len() > TOKEN_ACCOUNT_BASE_LEN {
        require!(data[TOKEN_ACCOUNT_BASE_LEN] == ACCOUNT_TYPE_ACCOUNT, DistributorError::InvalidAccountData);
    }
    require!(data[108] != ACCOUNT_STATE_UNINITIALIZED, DistributorError::InvalidAccountData);
    Ok(TokenAccountView {
        mint: Pubkey::new_from_array(data[0..32].try_into().unwrap()),
        owner: Pubkey::new_from_array(data[32..64].try_into().unwrap()),
        amount: u64::from_le_bytes(data[64..72].try_into().unwrap()),
    })
}

pub fn read_mint_decimals(mint_ai: &AccountInfo) -> Result<u8> {
    let data = mint_ai.try_borrow_data()?;
    require!(data.len() >= MINT_BASE_LEN, DistributorError::InvalidAccountData);
    Ok(data[44])
}

fn for_each_mint_extension(data: &[u8], mut f: impl FnMut(u16, &[u8]) -> Result<()>) -> Result<()> {
    if data.len() == MINT_BASE_LEN {
        return Ok(());
    }
    require!(
        data.len() > TOKEN_ACCOUNT_BASE_LEN && data[TOKEN_ACCOUNT_BASE_LEN] == ACCOUNT_TYPE_MINT,
        DistributorError::InvalidAccountData
    );
    let mut offset = TOKEN_ACCOUNT_BASE_LEN + 1;
    while offset + 4 <= data.len() {
        let ext_type = u16::from_le_bytes([data[offset], data[offset + 1]]);
        let len = u16::from_le_bytes([data[offset + 2], data[offset + 3]]) as usize;
        if ext_type == EXT_UNINITIALIZED {
            break;
        }
        let start = offset + 4;
        let end = start.checked_add(len).ok_or(DistributorError::InvalidAccountData)?;
        require!(end <= data.len(), DistributorError::InvalidAccountData);
        f(ext_type, &data[start..end])?;
        offset = end;
    }
    Ok(())
}

/// Rejects mints the distributor can't safely hold or pay out: an active
/// transfer hook, permanent delegate, pausable, non-transferable,
/// confidential-transfer, default-frozen, a transfer fee (current or scheduled)
/// above `MAX_TRANSFER_FEE_BPS`, any extension type not on the allow-list, and —
/// unless explicitly allowed for this asset — a freeze authority. A transfer-fee
/// config authority is allowed.
pub fn vet_mint(mint_ai: &AccountInfo, token_program: &Pubkey, allow_freeze_authority: bool) -> Result<()> {
    require!(is_token_program(token_program), DistributorError::InvalidTokenProgram);
    require_keys_eq!(*mint_ai.owner, *token_program, DistributorError::InvalidTokenProgram);
    let data = mint_ai.try_borrow_data()?;
    require!(data.len() >= MINT_BASE_LEN, DistributorError::InvalidAccountData);
    require!(data[45] == 1, DistributorError::MintNotInitialized);
    let freeze_authority_tag = u32::from_le_bytes(data[46..50].try_into().unwrap());
    if freeze_authority_tag != 0 {
        require!(allow_freeze_authority, DistributorError::MintHasFreezeAuthority);
    }
    if data.len() > MINT_BASE_LEN {
        require_keys_eq!(*token_program, spl_token_2022::ID, DistributorError::InvalidAccountData);
    }
    for_each_mint_extension(&data, |ext_type, value| {
        // Authorities are checked, not just current settings: vetting runs once at
        // open, so any authority that could later add a hook, or close and re-create
        // the mint, would bypass it. The transfer-fee authority is the one accepted
        // exception (see EXT_TRANSFER_FEE_CONFIG below).
        let unset = |bytes: &[u8]| bytes.iter().all(|b| *b == 0);
        match ext_type {
            EXT_INTEREST_BEARING_CONFIG
            | EXT_METADATA_POINTER
            | EXT_TOKEN_METADATA
            | EXT_GROUP_POINTER
            | EXT_TOKEN_GROUP
            | EXT_GROUP_MEMBER_POINTER
            | EXT_TOKEN_GROUP_MEMBER => Ok(()),
            EXT_TRANSFER_FEE_CONFIG => {
                // transfer_fee_config_authority(32), withdraw_withheld_authority(32), withheld(8),
                // then older and newer fees of epoch u64, maximum_fee u64, basis_points u16 (18 each)
                require!(value.len() >= 108, DistributorError::InvalidAccountData);
                // A fee authority is accepted (StonkFun's reward coins keep one). It can only schedule
                // a new fee, which Token-2022 applies two epochs later, so pushed payouts land long
                // before; payouts left for self-claim and expiry leftovers carry that risk.
                // Both fees are capped: the current one and any already scheduled.
                let older_bps = u16::from_le_bytes([value[88], value[89]]);
                let newer_bps = u16::from_le_bytes([value[106], value[107]]);
                require!(
                    older_bps <= MAX_TRANSFER_FEE_BPS && newer_bps <= MAX_TRANSFER_FEE_BPS,
                    DistributorError::MintTransferFeeTooHigh
                );
                Ok(())
            }
            EXT_MINT_CLOSE_AUTHORITY => {
                require!(value.len() >= 32, DistributorError::InvalidAccountData);
                require!(unset(&value[0..32]), DistributorError::MintHasCloseAuthority);
                Ok(())
            }
            EXT_DEFAULT_ACCOUNT_STATE => {
                require!(!value.is_empty(), DistributorError::InvalidAccountData);
                require!(value[0] != ACCOUNT_STATE_FROZEN, DistributorError::MintDefaultFrozen);
                Ok(())
            }
            EXT_TRANSFER_HOOK => {
                // authority: OptionalNonZeroPubkey(32), program_id: OptionalNonZeroPubkey(32)
                require!(value.len() >= 64, DistributorError::InvalidAccountData);
                require!(unset(&value[0..64]), DistributorError::MintHasTransferHook);
                Ok(())
            }
            _ => err!(DistributorError::MintExtensionNotAllowed),
        }
    })
}

pub fn mint_has_extension(mint_ai: &AccountInfo, wanted: u16) -> Result<bool> {
    let data = mint_ai.try_borrow_data()?;
    let mut found = false;
    for_each_mint_extension(&data, |ext_type, _| {
        if ext_type == wanted {
            found = true;
        }
        Ok(())
    })?;
    Ok(found)
}

/// `transfer_checked` out of a `RoundAsset`-owned vault. Works for both token
/// programs: spl-token-2022's instruction builder accepts either program id
/// and the wire format is identical.
#[allow(clippy::too_many_arguments)]
pub fn transfer_from_vault<'info>(
    token_program: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    signer_seeds: &[&[u8]],
    amount: u64,
    decimals: u8,
) -> Result<()> {
    let ix = spl_token_2022::instruction::transfer_checked(
        token_program.key,
        vault.key,
        mint.key,
        destination.key,
        authority.key,
        &[],
        amount,
        decimals,
    )?;
    invoke_signed(
        &ix,
        &[vault.clone(), mint.clone(), destination.clone(), authority.clone(), token_program.clone()],
        &[signer_seeds],
    )?;
    Ok(())
}

pub fn close_vault<'info>(
    token_program: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    let ix = spl_token_2022::instruction::close_account(token_program.key, vault.key, destination.key, authority.key, &[])?;
    invoke_signed(
        &ix,
        &[vault.clone(), destination.clone(), authority.clone(), token_program.clone()],
        &[signer_seeds],
    )?;
    Ok(())
}

/// Permissionless Token-2022 instruction; a vault holding withheld transfer
/// fees can't be closed until they're harvested back to the mint.
pub fn harvest_withheld_to_mint<'info>(
    token_program: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
) -> Result<()> {
    let ix = spl_token_2022::extension::transfer_fee::instruction::harvest_withheld_tokens_to_mint(
        token_program.key,
        mint.key,
        &[vault.key],
    )?;
    invoke(&ix, &[mint.clone(), vault.clone(), token_program.clone()])?;
    Ok(())
}
