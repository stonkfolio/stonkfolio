//! A round's sampling lifecycle, enforced on-chain:
//!
//!   open_round    keeper commits sha256(secret) — once per round id
//!   close_window  keeper records the snapshot chain head; the program checks
//!                 the minimum window and reads SOL/USD from Pyth itself
//!   record_seed   anyone: the program takes the first slot hash at or after
//!                 close_slot + seed_slot_offset from SlotHashes
//!   commit_round  keeper reveals the secret and commits (commit_round.rs)
//!
//! A round can be abandoned while its window is open; a day after the window
//! closed if the seed block aged out of SlotHashes unrecorded (counted on the
//! distributor, since the seed hash is public before it is recorded and a skipped
//! record is a possible re-draw); or — only as an escape if the keeper's secret
//! is lost — seven days after seeding. Discarding a draw costs at least a day
//! and is publicly counted; a seeded draw can't be discarded for a week.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::slot_hashes;

use crate::errors::DistributorError;
use crate::events::{RoundAbandoned, RoundOpened, SeedRecorded, WindowClosed};
use crate::pyth::read_price_update;
use crate::slot_hashes::{find_seed, SeedLookup};
use crate::state::{abandon_reason, AbandonReason, Distributor, IntentStatus, RoundIntent};

fn require_intent_of(intent: &RoundIntent, distributor: &Account<Distributor>) -> Result<()> {
    require_keys_eq!(intent.distributor, distributor.key(), DistributorError::IntentMismatch);
    Ok(())
}

pub fn open_round(ctx: Context<OpenRound>, round_id: u64, secret_commitment: [u8; 32]) -> Result<()> {
    let distributor = &ctx.accounts.distributor;
    require_keys_eq!(
        ctx.accounts.root_authority.key(),
        distributor.root_authority,
        DistributorError::Unauthorized
    );
    require!(round_id == distributor.next_round_id, DistributorError::InvalidRoundId);

    let clock = Clock::get()?;
    let intent = &mut ctx.accounts.intent;
    intent.distributor = distributor.key();
    intent.round_id = round_id;
    intent.status = IntentStatus::Open;
    intent.bump = ctx.bumps.intent;
    intent.secret_commitment = secret_commitment;
    intent.open_slot = clock.slot;
    intent.open_ts = clock.unix_timestamp;

    emit!(RoundOpened {
        distributor: distributor.key(),
        round_id,
        secret_commitment,
        open_slot: clock.slot,
    });
    Ok(())
}

pub fn close_window(ctx: Context<CloseWindow>, snapshot_chain_head: [u8; 32], snapshot_count: u32) -> Result<()> {
    let distributor = &ctx.accounts.distributor;
    require_keys_eq!(
        ctx.accounts.root_authority.key(),
        distributor.root_authority,
        DistributorError::Unauthorized
    );
    let intent = &mut ctx.accounts.intent;
    require_intent_of(intent, distributor)?;
    require!(intent.status == IntentStatus::Open, DistributorError::InvalidIntentStatus);
    require!(snapshot_count >= 1, DistributorError::EmptyWindow);

    let clock = Clock::get()?;
    let open_for = clock.unix_timestamp.saturating_sub(intent.open_ts);
    require!(open_for >= distributor.min_window_secs as i64, DistributorError::WindowTooShort);

    require_keys_eq!(
        ctx.accounts.price_update.key(),
        distributor.price_feed_account,
        DistributorError::PriceFeedMismatch
    );
    let price = read_price_update(&ctx.accounts.price_update.to_account_info())?;
    require!(price.feed_id == distributor.price_feed_id, DistributorError::PriceFeedMismatch);
    require!(price.price > 0, DistributorError::InvalidPrice);
    // i128: publish_time is untrusted input and could sit at either end of i64.
    let age = clock.unix_timestamp as i128 - price.publish_time as i128;
    let max_age = distributor.max_price_age_secs as i128;
    require!(age <= max_age, DistributorError::PriceTooOld);
    // A little clock skew is normal; a price stamped further ahead than the age limit is not.
    require!(age >= -max_age, DistributorError::PriceFromTheFuture);
    require!(
        (price.conf as u128) * 10_000 <= (price.price as u128) * (distributor.max_price_conf_bps as u128),
        DistributorError::PriceConfidenceTooWide
    );

    intent.close_slot = clock.slot;
    intent.close_ts = clock.unix_timestamp;
    intent.snapshot_chain_head = snapshot_chain_head;
    intent.snapshot_count = snapshot_count;
    intent.sol_usd_price = price.price;
    intent.sol_usd_conf = price.conf;
    intent.sol_usd_exponent = price.exponent;
    intent.sol_usd_publish_time = price.publish_time;
    intent.status = IntentStatus::Closed;

    emit!(WindowClosed {
        distributor: distributor.key(),
        round_id: intent.round_id,
        close_slot: clock.slot,
        snapshot_count,
        snapshot_chain_head,
        sol_usd_price: price.price,
        sol_usd_exponent: price.exponent,
    });
    Ok(())
}

pub fn record_seed(ctx: Context<RecordSeed>) -> Result<()> {
    let distributor = &ctx.accounts.distributor;
    let intent = &mut ctx.accounts.intent;
    require_intent_of(intent, distributor)?;
    require!(intent.status == IntentStatus::Closed, DistributorError::InvalidIntentStatus);

    let target = intent
        .close_slot
        .checked_add(distributor.seed_slot_offset as u64)
        .ok_or(DistributorError::Overflow)?;
    let data = ctx.accounts.slot_hashes.try_borrow_data()?;
    match find_seed(&data, target)? {
        SeedLookup::Found { slot, hash } => {
            intent.seed_slot = slot;
            intent.seed_hash = hash;
            intent.seed_ts = Clock::get()?.unix_timestamp;
            intent.status = IntentStatus::Seeded;
            emit!(SeedRecorded {
                distributor: distributor.key(),
                round_id: intent.round_id,
                seed_slot: slot,
                seed_hash: hash,
            });
            Ok(())
        }
        SeedLookup::NotYet => err!(DistributorError::SeedNotYetAvailable),
        SeedLookup::Expired => err!(DistributorError::SeedExpired),
    }
}

pub fn abandon_round(ctx: Context<AbandonRound>) -> Result<()> {
    let distributor = &mut ctx.accounts.distributor;
    require_keys_eq!(
        ctx.accounts.root_authority.key(),
        distributor.root_authority,
        DistributorError::Unauthorized
    );
    let intent = &mut ctx.accounts.intent;
    require_keys_eq!(intent.distributor, distributor.key(), DistributorError::IntentMismatch);
    require!(intent.round_id == distributor.next_round_id, DistributorError::InvalidRoundId);

    let seed_expired = if intent.status == IntentStatus::Closed {
        let target = intent
            .close_slot
            .checked_add(distributor.seed_slot_offset as u64)
            .ok_or(DistributorError::Overflow)?;
        let data = ctx.accounts.slot_hashes.try_borrow_data()?;
        find_seed(&data, target)? == SeedLookup::Expired
    } else {
        false
    };
    let now = Clock::get()?.unix_timestamp;
    let reason = abandon_reason(intent.status, seed_expired, now, intent.close_ts, intent.seed_ts)
        .ok_or(DistributorError::CannotAbandon)?;

    if reason == AbandonReason::SeedExpired {
        distributor.expired_seed_abandons = distributor
            .expired_seed_abandons
            .checked_add(1)
            .ok_or(DistributorError::Overflow)?;
    }
    intent.status = IntentStatus::Abandoned;
    distributor.next_round_id = distributor.next_round_id.checked_add(1).ok_or(DistributorError::Overflow)?;
    emit!(RoundAbandoned {
        distributor: distributor.key(),
        round_id: intent.round_id,
        reason,
        expired_seed_abandons: distributor.expired_seed_abandons,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct OpenRound<'info> {
    pub root_authority: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub distributor: Box<Account<'info, Distributor>>,

    #[account(
        init,
        payer = payer,
        space = RoundIntent::SIZE,
        seeds = [b"intent", distributor.key().as_ref(), round_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub intent: Box<Account<'info, RoundIntent>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseWindow<'info> {
    pub root_authority: Signer<'info>,

    pub distributor: Box<Account<'info, Distributor>>,

    #[account(mut)]
    pub intent: Box<Account<'info, RoundIntent>>,

    /// CHECK: must equal distributor.price_feed_account; owner and contents checked in the handler.
    pub price_update: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RecordSeed<'info> {
    pub distributor: Box<Account<'info, Distributor>>,

    #[account(mut)]
    pub intent: Box<Account<'info, RoundIntent>>,

    /// CHECK: pinned to the SlotHashes sysvar address.
    #[account(address = slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AbandonRound<'info> {
    pub root_authority: Signer<'info>,

    #[account(mut)]
    pub distributor: Box<Account<'info, Distributor>>,

    #[account(mut)]
    pub intent: Box<Account<'info, RoundIntent>>,

    /// CHECK: pinned to the SlotHashes sysvar address.
    #[account(address = slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

#[cfg(test)]
mod tests {
    use crate::state::{abandon_reason, AbandonReason, IntentStatus, EXPIRED_SEED_ABANDON_DELAY_SECS, SEEDED_ABANDON_DELAY_SECS};

    const CLOSE: i64 = 1_789_000_000;

    #[test]
    fn an_open_round_can_be_abandoned() {
        assert_eq!(abandon_reason(IntentStatus::Open, false, CLOSE, 0, 0), Some(AbandonReason::WindowOpen));
    }

    #[test]
    fn a_closed_round_only_once_its_seed_expired_and_a_day_has_passed_since_close() {
        let day = EXPIRED_SEED_ABANDON_DELAY_SECS;
        assert_eq!(abandon_reason(IntentStatus::Closed, false, CLOSE + 10 * day, CLOSE, 0), None, "seed still recordable");
        assert_eq!(abandon_reason(IntentStatus::Closed, true, CLOSE + 300, CLOSE, 0), None, "minutes after expiry");
        assert_eq!(abandon_reason(IntentStatus::Closed, true, CLOSE + day - 1, CLOSE, 0), None);
        assert_eq!(abandon_reason(IntentStatus::Closed, true, CLOSE + day, CLOSE, 0), Some(AbandonReason::SeedExpired));
    }

    #[test]
    fn a_seeded_round_only_after_seven_days_and_finished_rounds_never() {
        let seeded = CLOSE + 60;
        assert_eq!(abandon_reason(IntentStatus::Seeded, false, seeded + SEEDED_ABANDON_DELAY_SECS - 1, CLOSE, seeded), None);
        assert_eq!(
            abandon_reason(IntentStatus::Seeded, false, seeded + SEEDED_ABANDON_DELAY_SECS, CLOSE, seeded),
            Some(AbandonReason::SecretLost)
        );
        for status in [IntentStatus::Committed, IntentStatus::Abandoned] {
            assert_eq!(abandon_reason(status, true, i64::MAX, CLOSE, seeded), None);
        }
    }
}
