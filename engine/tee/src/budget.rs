//! The in-memory ledger of requests and the budget their allowed countersigns reserve.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use time::OffsetDateTime;
use ulid::Ulid;

use crate::wire::Countersigned;

/// One request on one mandate: its input, what it reserved and its answer, all until one
/// expiry.
#[derive(Debug)]
struct Record {
    /// The hash of the request's whole input.
    digest: [u8; 32],
    /// The amount reserved for its ALLOW, once reserved.
    reserved_minor: Option<i64>,
    expires_at: OffsetDateTime,
    /// Countersigns of this request still running.
    running: usize,
    answer: Option<Box<Countersigned>>,
}

type Ledger = BTreeMap<[u8; 32], BTreeMap<Ulid, Record>>;

/// Requests and their reservations per mandate, keyed by the mandate challenge `M`. `M` commits
/// to the whole mandate, so two mandates never share a budget even if they reuse a `mid`.
///
/// A request id is bound to the digest of its whole input by its first claim. The record holds
/// the reservation and the answer and expires with the countersign, all at once.
///
/// The ledger lives only in RAM; [`crate::Engine`] allows nothing until every reservation a
/// previous boot could have made has expired.
#[derive(Debug, Default)]
pub struct Budget(Mutex<Ledger>);

/// What [`Budget::claim`] found for a request.
#[derive(Debug)]
pub enum Claimed<'a> {
    /// The request was answered for this input.
    Answered(Box<Countersigned>),
    /// The request is bound to this input; work on it holds the claim.
    Working(ClaimGuard<'a>),
}

/// The id is bound to another input, or its reservation is for another amount.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Replay;

/// A running countersign's hold on its request. Dropped without an answer by the last runner,
/// it removes the record and with it the reservation.
#[derive(Debug)]
pub struct ClaimGuard<'a> {
    budget: &'a Budget,
    mandate: [u8; 32],
    request: Ulid,
    expires_at: OffsetDateTime,
}

impl Budget {
    /// Binds `request` on `mandate` to `digest` until `expires_at`, unless a live record binds
    /// it to another digest. A live record keeps its own expiry. Records expired at `now` are
    /// dropped whole.
    pub fn claim(
        &self,
        mandate: &[u8; 32],
        request: Ulid,
        digest: [u8; 32],
        expires_at: OffsetDateTime,
        now: OffsetDateTime,
    ) -> Result<Claimed<'_>, Replay> {
        let mut ledger = self.lock();
        let records = ledger.entry(*mandate).or_default();
        records.retain(|_, r| r.running > 0 || r.expires_at > now);
        let record = records.entry(request).or_insert(Record {
            digest,
            reserved_minor: None,
            expires_at,
            running: 0,
            answer: None,
        });
        if record.digest != digest || record.expires_at <= now {
            return Err(Replay);
        }
        if let Some(out) = &record.answer {
            return Ok(Claimed::Answered(out.clone()));
        }
        record.running += 1;
        Ok(Claimed::Working(ClaimGuard {
            budget: self,
            mandate: *mandate,
            request,
            expires_at: record.expires_at,
        }))
    }

    fn lock(&self) -> MutexGuard<'_, Ledger> {
        // The ledger is consistent after every statement, so a panicked holder leaves it usable.
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl ClaimGuard<'_> {
    /// When the request's record, reservation and countersign expire.
    pub fn expires_at(&self) -> OffsetDateTime {
        self.expires_at
    }

    /// `max − captured − Σ reservations of records unexpired at now` on the request's mandate.
    pub fn left(&self, max: i64, captured_minor: i64, now: OffsetDateTime) -> i64 {
        left(&self.budget.lock(), &self.mandate, max, captured_minor, now)
    }

    /// Reserves `amount` for the request if it is within what is [`Self::left`]; the check and
    /// the reservation are one step, so concurrent requests never reserve past `max`. A request
    /// that already reserved keeps its reservation, which must be for `amount`.
    pub fn reserve(
        &self,
        max: i64,
        captured_minor: i64,
        amount: i64,
        now: OffsetDateTime,
    ) -> Result<bool, Replay> {
        let mut ledger = self.budget.lock();
        let room = left(&ledger, &self.mandate, max, captured_minor, now);
        let record = ledger
            .get_mut(&self.mandate)
            .and_then(|records| records.get_mut(&self.request))
            .ok_or(Replay)?;
        match record.reserved_minor {
            Some(reserved) if reserved == amount => Ok(true),
            Some(_) => Err(Replay),
            None if amount > room => Ok(false),
            None => {
                record.reserved_minor = Some(amount);
                Ok(true)
            }
        }
    }

    /// Records `out` as the answer. A countersign of the same request that answered first keeps
    /// its answer, which is returned.
    pub fn answer(self, out: Countersigned) -> Result<Countersigned, Replay> {
        let mut ledger = self.budget.lock();
        let record = ledger
            .get_mut(&self.mandate)
            .and_then(|records| records.get_mut(&self.request))
            .ok_or(Replay)?;
        Ok((**record.answer.get_or_insert_with(|| Box::new(out))).clone())
    }
}

impl Drop for ClaimGuard<'_> {
    fn drop(&mut self) {
        let mut ledger = self.budget.lock();
        let Some(records) = ledger.get_mut(&self.mandate) else {
            return;
        };
        let Some(record) = records.get_mut(&self.request) else {
            return;
        };
        record.running -= 1;
        if record.running == 0 && record.answer.is_none() {
            records.remove(&self.request);
        }
    }
}

fn left(
    ledger: &Ledger,
    mandate: &[u8; 32],
    max: i64,
    captured_minor: i64,
    now: OffsetDateTime,
) -> i64 {
    let reserved = ledger
        .get(mandate)
        .into_iter()
        .flat_map(BTreeMap::values)
        .filter(|r| r.expires_at > now)
        .filter_map(|r| r.reserved_minor)
        .fold(0i64, i64::saturating_add);
    max.saturating_sub(captured_minor).saturating_sub(reserved)
}

#[cfg(test)]
mod tests {
    use time::OffsetDateTime;
    use ulid::Ulid;

    use super::{Budget, ClaimGuard, Claimed, Replay};

    fn at(s: i64) -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(s).unwrap()
    }

    fn id(n: u128) -> Ulid {
        Ulid::from_parts(0, n)
    }

    fn work(b: &Budget, request: Ulid, digest: u8, expires: i64, now: i64) -> ClaimGuard<'_> {
        match b
            .claim(&[1; 32], request, [digest; 32], at(expires), at(now))
            .unwrap()
        {
            Claimed::Working(g) => g,
            Claimed::Answered(_) => panic!("unanswered"),
        }
    }

    #[test]
    fn reservations_count_until_they_expire() {
        let b = Budget::default();
        let g1 = work(&b, id(1), 1, 900, 0);
        let g2 = work(&b, id(2), 2, 1_799, 899);
        assert_eq!(g1.left(10_000, 1_000, at(0)), 9_000);
        assert_eq!(g1.reserve(10_000, 1_000, 6_000, at(0)), Ok(true));
        assert_eq!(g2.left(10_000, 1_000, at(899)), 3_000);
        assert_eq!(g2.reserve(10_000, 1_000, 3_001, at(899)), Ok(false));
        assert_eq!(g2.reserve(10_000, 1_000, 3_000, at(899)), Ok(true));
        assert_eq!(g2.left(10_000, 1_000, at(900)), 6_000);
    }

    #[test]
    fn a_request_id_is_bound_to_one_input_and_one_amount() {
        let b = Budget::default();
        let g = work(&b, id(1), 1, 900, 0);
        let other = b.claim(&[1; 32], id(1), [2; 32], at(900), at(0));
        assert_eq!(other.err(), Some(Replay));
        assert_eq!(g.reserve(10_000, 0, 6_000, at(0)), Ok(true));
        // The same input running twice is reserved once, and only for the same amount.
        let again = work(&b, id(1), 1, 900, 0);
        assert_eq!(again.reserve(10_000, 0, 6_000, at(0)), Ok(true));
        assert_eq!(again.reserve(10_000, 0, 9_400, at(0)), Err(Replay));
        assert_eq!(again.left(10_000, 0, at(0)), 4_000);
        // The same id on another mandate is another request.
        assert!(b.claim(&[2; 32], id(1), [2; 32], at(900), at(0)).is_ok());
    }

    #[test]
    fn a_record_keeps_its_first_expiry_and_its_reservation_expires_with_it() {
        let b = Budget::default();
        let g = work(&b, id(1), 1, 900, 0);
        assert_eq!(g.reserve(10_000, 0, 6_000, at(0)), Ok(true));
        // A later runner of the same request gets the record's expiry, not its own.
        let late = work(&b, id(1), 1, 901, 1);
        assert_eq!(late.expires_at(), at(900));
        assert_eq!(late.left(10_000, 0, at(899)), 4_000);
        // At the record's expiry its reservation no longer counts.
        let next = work(&b, id(2), 2, 1_800, 900);
        assert_eq!(next.left(10_000, 0, at(900)), 10_000);
        drop((g, late));
        assert_eq!(next.reserve(10_000, 0, 9_400, at(900)), Ok(true));
        assert_eq!(next.left(10_000, 0, at(900)), 600);
    }

    #[test]
    fn a_request_dropped_without_an_answer_releases_its_reservation() {
        let b = Budget::default();
        let (g, other) = (work(&b, id(1), 1, 900, 0), work(&b, id(1), 1, 900, 0));
        assert_eq!(g.reserve(10_000, 0, 6_000, at(0)), Ok(true));
        drop(g);
        // Another countersign of the request still holds it.
        assert_eq!(other.left(10_000, 0, at(0)), 4_000);
        drop(other);
        let fresh = work(&b, id(2), 2, 900, 0);
        assert_eq!(fresh.left(10_000, 0, at(0)), 10_000);
        // And the id is free for another input.
        assert!(b.claim(&[1; 32], id(1), [3; 32], at(900), at(0)).is_ok());
    }
}
