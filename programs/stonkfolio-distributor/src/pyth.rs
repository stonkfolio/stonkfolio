//! Minimal reader for Pyth's pull-oracle `PriceUpdateV2` accounts.
//!
//! Layout: discriminator(8), write_authority(32), verification_level (enum:
//! Partial{num_signatures: u8} = 2 bytes, Full = 1 byte), then the price
//! message: feed_id(32), price i64, conf u64, exponent i32, publish_time i64,
//! prev_publish_time i64, ema_price i64, ema_conf u64; then posted_slot u64.
//! Only fully verified updates are accepted, so the layout after the level
//! is at a fixed offset.
use anchor_lang::prelude::*;

use crate::errors::DistributorError;

/// rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ — Pyth Solana receiver (pull oracle).
pub const PYTH_RECEIVER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    12, 183, 250, 187, 82, 247, 166, 72, 187, 91, 49, 125, 154, 1, 139, 144, 87, 203, 2, 71, 116, 250, 254, 1, 230, 196, 223, 152, 204,
    56, 88, 129,
]);
/// pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT — Pyth push oracle, which owns the
/// write authority of the continuously updated feed accounts.
pub const PYTH_PUSH_ORACLE_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    12, 74, 160, 18, 142, 149, 211, 225, 98, 42, 165, 1, 197, 133, 169, 235, 7, 179, 115, 84, 193, 8, 234, 11, 121, 27, 69, 109, 199, 238,
    163, 54,
]);
/// Pyth sponsors (keeps updating) the shard-0 account of each feed.
pub const PYTH_SPONSORED_SHARD: u16 = 0;
const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd];

/// The push oracle's shard-0 account for `feed_id`. Only verified updates newer
/// than the stored one can be written to it, so a distributor pinned to it can't
/// be fed a hand-picked older price from an account its creator posted.
pub fn sponsored_feed_account(feed_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[&PYTH_SPONSORED_SHARD.to_le_bytes(), feed_id], &PYTH_PUSH_ORACLE_PROGRAM_ID).0
}
const FULL_VERIFICATION: u8 = 1;
const MESSAGE_OFFSET: usize = 8 + 32 + 1;
const MESSAGE_LEN: usize = 32 + 8 + 8 + 4 + 8;

pub struct PythPrice {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
}

pub fn parse_price_update(data: &[u8]) -> Result<PythPrice> {
    require!(
        data.len() >= MESSAGE_OFFSET + MESSAGE_LEN && data[..8] == PRICE_UPDATE_V2_DISCRIMINATOR,
        DistributorError::InvalidPriceAccount
    );
    require!(data[40] == FULL_VERIFICATION, DistributorError::PriceNotFullyVerified);
    let message = &data[MESSAGE_OFFSET..MESSAGE_OFFSET + MESSAGE_LEN];
    Ok(PythPrice {
        feed_id: message[0..32].try_into().unwrap(),
        price: i64::from_le_bytes(message[32..40].try_into().unwrap()),
        conf: u64::from_le_bytes(message[40..48].try_into().unwrap()),
        exponent: i32::from_le_bytes(message[48..52].try_into().unwrap()),
        publish_time: i64::from_le_bytes(message[52..60].try_into().unwrap()),
    })
}

pub fn read_price_update(account: &AccountInfo) -> Result<PythPrice> {
    require_keys_eq!(*account.owner, PYTH_RECEIVER_PROGRAM_ID, DistributorError::InvalidPriceAccount);
    let data = account.try_borrow_data()?;
    parse_price_update(&data)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update(level: &[u8]) -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&PRICE_UPDATE_V2_DISCRIMINATOR);
        data.extend_from_slice(&[1u8; 32]);
        data.extend_from_slice(level);
        data.extend_from_slice(&[7u8; 32]);
        data.extend_from_slice(&9_938_001_756i64.to_le_bytes());
        data.extend_from_slice(&1_498_244u64.to_le_bytes());
        data.extend_from_slice(&(-8i32).to_le_bytes());
        data.extend_from_slice(&1_789_345_525i64.to_le_bytes());
        data.extend_from_slice(&[0u8; 32]);
        data
    }

    #[test]
    fn receiver_program_id_matches_its_base58_address() {
        use std::str::FromStr;
        assert_eq!(
            PYTH_RECEIVER_PROGRAM_ID,
            Pubkey::from_str("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ").unwrap()
        );
    }

    #[test]
    fn push_oracle_id_and_sol_usd_feed_account_match_mainnet() {
        use std::str::FromStr;
        assert_eq!(
            PYTH_PUSH_ORACLE_PROGRAM_ID,
            Pubkey::from_str("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT").unwrap()
        );
        let sol_usd: [u8; 32] = [
            0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4, 0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1, 0xda, 0x39, 0x2a, 0x0d, 0x2f, 0x8e, 0xd0,
            0xc6, 0xc7, 0xbc, 0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5, 0x6d,
        ];
        // The account the keeper's policy names and the one measured updating on mainnet (2026-09-14).
        assert_eq!(
            sponsored_feed_account(&sol_usd),
            Pubkey::from_str("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE").unwrap()
        );
    }

    #[test]
    fn parses_a_fully_verified_update() {
        let price = parse_price_update(&update(&[1])).unwrap();
        assert_eq!(price.feed_id, [7u8; 32]);
        assert_eq!(price.price, 9_938_001_756);
        assert_eq!(price.conf, 1_498_244);
        assert_eq!(price.exponent, -8);
        assert_eq!(price.publish_time, 1_789_345_525);
    }

    #[test]
    fn rejects_partial_verification_and_garbage() {
        assert!(parse_price_update(&update(&[0, 3])).is_err());
        assert!(parse_price_update(&[0u8; 134]).is_err());
        assert!(parse_price_update(&update(&[1])[..60]).is_err());
    }
}
