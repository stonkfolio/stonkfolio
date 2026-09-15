//! Picks a round's seed from the SlotHashes sysvar: the hash of the first
//! slot at or after the target. Nobody chooses the seed — any caller at any
//! moment gets the same answer while that slot is still in the sysvar.
//!
//! Sysvar layout: u64 LE entry count, then (slot u64 LE, hash [u8; 32])
//! entries ordered from newest to oldest; skipped slots have no entry.
use anchor_lang::prelude::*;

use crate::errors::DistributorError;

const ENTRY_LEN: usize = 40;

#[derive(Debug, PartialEq, Eq)]
pub enum SeedLookup {
    Found { slot: u64, hash: [u8; 32] },
    /// The target slot hasn't been produced yet.
    NotYet,
    /// Everything left in the sysvar is newer than the target, so which slot
    /// came first at or after it can no longer be proven.
    Expired,
}

pub fn find_seed(data: &[u8], target: u64) -> Result<SeedLookup> {
    require!(data.len() >= 8, DistributorError::InvalidAccountData);
    let count = u64::from_le_bytes(data[0..8].try_into().unwrap()) as usize;
    let end = count
        .checked_mul(ENTRY_LEN)
        .and_then(|n| n.checked_add(8))
        .ok_or(DistributorError::InvalidAccountData)?;
    require!(data.len() >= end, DistributorError::InvalidAccountData);

    let slot_at = |i: usize| u64::from_le_bytes(data[8 + i * ENTRY_LEN..16 + i * ENTRY_LEN].try_into().unwrap());
    let hash_at = |i: usize| -> [u8; 32] { data[16 + i * ENTRY_LEN..8 + (i + 1) * ENTRY_LEN].try_into().unwrap() };

    if count == 0 || slot_at(0) < target {
        return Ok(SeedLookup::NotYet);
    }
    for i in 1..count {
        if slot_at(i) < target {
            // Entry i-1 is the oldest slot at or after the target, with an older slot proving nothing was skipped.
            return Ok(SeedLookup::Found { slot: slot_at(i - 1), hash: hash_at(i - 1) });
        }
    }
    let oldest = count - 1;
    if slot_at(oldest) == target {
        Ok(SeedLookup::Found { slot: target, hash: hash_at(oldest) })
    } else {
        Ok(SeedLookup::Expired)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sysvar(slots: &[u64]) -> Vec<u8> {
        let mut data = (slots.len() as u64).to_le_bytes().to_vec();
        for slot in slots {
            data.extend_from_slice(&slot.to_le_bytes());
            data.extend_from_slice(&[*slot as u8; 32]);
        }
        data
    }

    #[test]
    fn finds_the_first_slot_at_or_after_the_target() {
        let data = sysvar(&[110, 108, 105, 104, 100]);
        assert_eq!(find_seed(&data, 105).unwrap(), SeedLookup::Found { slot: 105, hash: [105; 32] });
        // 106 and 107 were skipped: the first produced slot after 106 is 108
        assert_eq!(find_seed(&data, 106).unwrap(), SeedLookup::Found { slot: 108, hash: [108; 32] });
        assert_eq!(find_seed(&data, 110).unwrap(), SeedLookup::Found { slot: 110, hash: [110; 32] });
    }

    #[test]
    fn reports_not_yet_and_expired() {
        let data = sysvar(&[110, 108, 105]);
        assert_eq!(find_seed(&data, 111).unwrap(), SeedLookup::NotYet);
        assert_eq!(find_seed(&data, 104).unwrap(), SeedLookup::Expired);
        assert_eq!(find_seed(&data, 105).unwrap(), SeedLookup::Found { slot: 105, hash: [105; 32] });
        assert_eq!(find_seed(&sysvar(&[]), 1).unwrap(), SeedLookup::NotYet);
    }

    #[test]
    fn rejects_truncated_data() {
        let mut data = sysvar(&[110, 108]);
        data.truncate(50);
        assert!(find_seed(&data, 100).is_err());
    }
}
