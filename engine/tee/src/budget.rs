//! The in-memory ledger of budget reserved by allowed countersigns.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use time::OffsetDateTime;

/// Amounts reserved per mandate `mid`, each until its countersign expires.
///
/// The ledger lives only in RAM; [`crate::Engine`] allows nothing until every reservation a
/// previous boot could have made has expired.
#[derive(Debug, Default)]
pub struct Budget(Mutex<BTreeMap<String, Vec<(i64, OffsetDateTime)>>>);

impl Budget {
    /// `max − captured − Σ reservations unexpired at now`.
    pub fn left(&self, mid: &str, max: i64, captured_minor: i64, now: OffsetDateTime) -> i64 {
        left(&self.lock(), mid, max, captured_minor, now)
    }

    /// Reserves `amount` until `expires_at` if it is within what is [`Self::left`]; the check
    /// and the reservation are one step, so concurrent callers never reserve past `max`.
    pub fn reserve(
        &self,
        mid: &str,
        max: i64,
        captured_minor: i64,
        amount: i64,
        now: OffsetDateTime,
        expires_at: OffsetDateTime,
    ) -> bool {
        let mut ledger = self.lock();
        if amount > left(&ledger, mid, max, captured_minor, now) {
            return false;
        }
        let reserved = ledger.entry(mid.to_owned()).or_default();
        reserved.retain(|(_, until)| *until > now);
        reserved.push((amount, expires_at));
        true
    }

    fn lock(&self) -> MutexGuard<'_, BTreeMap<String, Vec<(i64, OffsetDateTime)>>> {
        // The ledger is consistent after every statement, so a panicked holder leaves it usable.
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn left(
    ledger: &BTreeMap<String, Vec<(i64, OffsetDateTime)>>,
    mid: &str,
    max: i64,
    captured_minor: i64,
    now: OffsetDateTime,
) -> i64 {
    let reserved = ledger
        .get(mid)
        .into_iter()
        .flatten()
        .filter(|(_, until)| *until > now)
        .fold(0i64, |sum, (amount, _)| sum.saturating_add(*amount));
    max.saturating_sub(captured_minor).saturating_sub(reserved)
}

#[cfg(test)]
mod tests {
    use time::OffsetDateTime;

    use super::Budget;

    fn at(s: i64) -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(s).unwrap()
    }

    #[test]
    fn reservations_count_until_they_expire() {
        let b = Budget::default();
        assert_eq!(b.left("m", 10_000, 1_000, at(0)), 9_000);
        assert!(b.reserve("m", 10_000, 1_000, 6_000, at(0), at(900)));
        assert_eq!(b.left("m", 10_000, 1_000, at(899)), 3_000);
        assert!(!b.reserve("m", 10_000, 1_000, 3_001, at(899), at(1_799)));
        assert!(b.reserve("m", 10_000, 1_000, 3_000, at(899), at(1_799)));
        assert_eq!(b.left("m", 10_000, 1_000, at(900)), 6_000);
        assert_eq!(b.left("other", 10_000, 0, at(0)), 10_000);
    }
}
