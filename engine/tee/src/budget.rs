//! The in-memory ledger of budget reserved by allowed countersigns.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use time::OffsetDateTime;
use ulid::Ulid;

/// A request's reservation: its id, amount and expiry.
type Reservation = (Ulid, i64, OffsetDateTime);

/// Amounts reserved per mandate, keyed by the mandate challenge `M`, each until its countersign
/// expires. `M` commits to the whole mandate, so two mandates never share a budget even if they
/// reuse a `mid`.
///
/// The ledger lives only in RAM; [`crate::Engine`] allows nothing until every reservation a
/// previous boot could have made has expired.
#[derive(Debug, Default)]
pub struct Budget(Mutex<BTreeMap<[u8; 32], Vec<Reservation>>>);

impl Budget {
    /// `max − captured − Σ reservations unexpired at now`.
    pub fn left(
        &self,
        mandate: &[u8; 32],
        max: i64,
        captured_minor: i64,
        now: OffsetDateTime,
    ) -> i64 {
        left(&self.lock(), mandate, max, captured_minor, now)
    }

    /// Reserves `amount` for `request` until `expires_at` if it is within what is
    /// [`Self::left`]; the check and the reservation are one step, so concurrent callers never
    /// reserve past `max`. A request that already holds a reservation keeps it and is not
    /// charged twice.
    #[allow(clippy::too_many_arguments)]
    pub fn reserve(
        &self,
        mandate: &[u8; 32],
        request: Ulid,
        max: i64,
        captured_minor: i64,
        amount: i64,
        now: OffsetDateTime,
        expires_at: OffsetDateTime,
    ) -> bool {
        let mut ledger = self.lock();
        let reserved = ledger.entry(*mandate).or_default();
        reserved.retain(|(_, _, until)| *until > now);
        if reserved.iter().any(|(id, ..)| *id == request) {
            return true;
        }
        if amount > left(&ledger, mandate, max, captured_minor, now) {
            return false;
        }
        ledger
            .entry(*mandate)
            .or_default()
            .push((request, amount, expires_at));
        true
    }

    fn lock(&self) -> MutexGuard<'_, BTreeMap<[u8; 32], Vec<Reservation>>> {
        // The ledger is consistent after every statement, so a panicked holder leaves it usable.
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn left(
    ledger: &BTreeMap<[u8; 32], Vec<Reservation>>,
    mandate: &[u8; 32],
    max: i64,
    captured_minor: i64,
    now: OffsetDateTime,
) -> i64 {
    let reserved = ledger
        .get(mandate)
        .into_iter()
        .flatten()
        .filter(|(_, _, until)| *until > now)
        .fold(0i64, |sum, (_, amount, _)| sum.saturating_add(*amount));
    max.saturating_sub(captured_minor).saturating_sub(reserved)
}

#[cfg(test)]
mod tests {
    use time::OffsetDateTime;
    use ulid::Ulid;

    use super::Budget;

    fn at(s: i64) -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(s).unwrap()
    }

    #[test]
    fn reservations_count_until_they_expire() {
        let (b, m) = (Budget::default(), [1; 32]);
        let id = |n| Ulid::from_parts(0, n);
        assert_eq!(b.left(&m, 10_000, 1_000, at(0)), 9_000);
        assert!(b.reserve(&m, id(1), 10_000, 1_000, 6_000, at(0), at(900)));
        assert_eq!(b.left(&m, 10_000, 1_000, at(899)), 3_000);
        assert!(!b.reserve(&m, id(2), 10_000, 1_000, 3_001, at(899), at(1_799)));
        assert!(b.reserve(&m, id(2), 10_000, 1_000, 3_000, at(899), at(1_799)));
        assert_eq!(b.left(&m, 10_000, 1_000, at(900)), 6_000);
        assert_eq!(b.left(&[2; 32], 10_000, 0, at(0)), 10_000);
    }

    #[test]
    fn a_request_is_reserved_once() {
        let (b, m) = (Budget::default(), [1; 32]);
        let id = Ulid::from_parts(0, 1);
        assert!(b.reserve(&m, id, 10_000, 0, 6_000, at(0), at(900)));
        assert!(b.reserve(&m, id, 10_000, 0, 6_000, at(1), at(900)));
        assert_eq!(b.left(&m, 10_000, 0, at(1)), 4_000);
    }
}
