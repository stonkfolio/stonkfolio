use anchor_lang::prelude::*;

#[error_code]
pub enum DistributorError {
    #[msg("Signer is not authorized for this instruction")]
    Unauthorized,
    #[msg("Invalid config value")]
    InvalidConfig,
    #[msg("No pending root authority, or signer is not the pending root authority")]
    NoPendingRootAuthority,
    #[msg("round_id must equal distributor.next_round_id")]
    InvalidRoundId,
    #[msg("asset_count must be at most MAX_ASSETS_PER_ROUND")]
    InvalidAssetCount,
    #[msg("expiry_ts is earlier than now + min_expiry_secs")]
    ExpiryTooSoon,
    #[msg("allow_freeze_authority_mask names an asset index >= asset_count")]
    InvalidAllowMask,
    #[msg("Round account does not match this asset")]
    RoundMismatch,
    #[msg("Distributor account does not match this asset")]
    DistributorMismatch,
    #[msg("Round intent does not belong to this distributor and round")]
    IntentMismatch,
    #[msg("Round intent is not in the required status")]
    InvalidIntentStatus,
    #[msg("Round window has not been open for the minimum duration")]
    WindowTooShort,
    #[msg("A window must include at least one snapshot")]
    EmptyWindow,
    #[msg("Revealed secret does not match the round's commitment")]
    SecretMismatch,
    #[msg("The seed block is not available yet")]
    SeedNotYetAvailable,
    #[msg("The seed block is no longer in SlotHashes; the round can only be abandoned")]
    SeedExpired,
    #[msg("A round can only be abandoned while open, a day after its window closed if its seed expired unrecorded, or seven days after seeding")]
    CannotAbandon,
    #[msg("Price account is not a Pyth PriceUpdateV2 account")]
    InvalidPriceAccount,
    #[msg("Price account or feed does not match the distributor's price feed")]
    PriceFeedMismatch,
    #[msg("Price update is not fully verified")]
    PriceNotFullyVerified,
    #[msg("Price update is too old")]
    PriceTooOld,
    #[msg("Price confidence interval is too wide")]
    PriceConfidenceTooWide,
    #[msg("Price must be positive")]
    InvalidPrice,
    #[msg("asset_idx is out of range for this round")]
    AssetIndexOutOfRange,
    #[msg("This asset index was already opened for this round")]
    AssetAlreadyOpened,
    #[msg("leaf_count must be between 1 and MAX_LEAVES_PER_ASSET")]
    InvalidLeafCount,
    #[msg("allocated must be greater than zero")]
    InvalidAllocation,
    #[msg("Asset tuple is not in the round's assets_root")]
    InvalidAssetProof,
    #[msg("Proof exceeds MAX_PROOF_LEN")]
    ProofTooLong,
    #[msg("Token program must be spl-token or spl-token-2022 and own the mint")]
    InvalidTokenProgram,
    #[msg("Account data is not a valid token mint or token account")]
    InvalidAccountData,
    #[msg("Mint is not initialized")]
    MintNotInitialized,
    #[msg("Mint carries a Token-2022 extension the distributor does not allow")]
    MintExtensionNotAllowed,
    #[msg("Mint has a freeze authority and this asset was not allow-listed for one")]
    MintHasFreezeAuthority,
    #[msg("Mint has a transfer hook program or an authority that could set one")]
    MintHasTransferHook,
    /// No longer returned: transfer-fee authorities are accepted, with fees capped by
    /// MAX_TRANSFER_FEE_BPS. Kept so every later error code keeps its number.
    #[msg("Mint has a transfer fee authority that could raise the fee")]
    MintHasFeeAuthority,
    #[msg("Mint has a close authority")]
    MintHasCloseAuthority,
    #[msg("Mint's default account state is frozen")]
    MintDefaultFrozen,
    #[msg("Mint does not match this asset")]
    MintMismatch,
    #[msg("Vault does not match this asset")]
    VaultMismatch,
    #[msg("Asset is not in the required status")]
    InvalidStatus,
    #[msg("Vault balance is below the committed allocation")]
    Underfunded,
    #[msg("Round has expired")]
    RoundExpired,
    #[msg("Round has not expired")]
    RoundNotExpired,
    #[msg("leaf_idx is out of range for this asset")]
    LeafIndexOutOfRange,
    #[msg("This leaf has already been paid")]
    AlreadyClaimed,
    #[msg("Payout proof does not match the asset's merkle_root")]
    InvalidProof,
    #[msg("Payout amount must be greater than zero")]
    ZeroAmount,
    #[msg("Payout would exceed the asset's committed allocation")]
    ExceedsAllocation,
    #[msg("Destination token account is not owned by the recipient")]
    ClaimDestinationMismatch,
    #[msg("Push payouts must go to the recipient's canonical associated token account")]
    DestinationNotCanonicalAta,
    #[msg("Rollover destination does not match the root authority")]
    RolloverMismatch,
    #[msg("Vault holds nothing beyond what is still owed")]
    NothingToSweep,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Payout block is misaligned, the wrong size, or has the wrong destination accounts")]
    InvalidBlock,
    #[msg("Price feed account must be Pyth's push-oracle account (shard 0) for the price feed id")]
    NotPythFeedAccount,
    #[msg("Price update is stamped further in the future than the price age limit allows")]
    PriceFromTheFuture,
    #[msg("Mint's transfer fee, current or scheduled, is above MAX_TRANSFER_FEE_BPS")]
    MintTransferFeeTooHigh,
    #[msg("A payout can't go to the asset's own vault or name the asset account as its recipient")]
    DestinationIsVault,
    #[msg("Proposed root authority must be a real key different from the current one")]
    InvalidRootAuthority,
}
