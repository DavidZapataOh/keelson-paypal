//! The in-memory ledger of request claims and the budget reserved by allowed countersigns.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use time::OffsetDateTime;
use ulid::Ulid;

use crate::wire::Countersigned;

/// A request's reservation against its mandate's budget.
#[derive(Debug)]
struct Reservation {
    request: Ulid,
    cart_hash: [u8; 32],
    amount: i64,
    until: OffsetDateTime,
}

/// The cart a request id is bound to, and the answer once given.
#[derive(Debug)]
struct Claim {
    cart_hash: [u8; 32],
    /// Countersigns of this request still running.
    running: usize,
    answer: Option<(OffsetDateTime, Countersigned)>,
}

#[derive(Debug, Default)]
struct Ledger {
    reserved: BTreeMap<[u8; 32], Vec<Reservation>>,
    claims: BTreeMap<([u8; 32], Ulid), Claim>,
}

/// Request claims and budget reservations per mandate, keyed by the mandate challenge `M`. `M`
/// commits to the whole mandate, so two mandates never share a budget even if they reuse a
/// `mid`. One lock guards both, so a request id is bound to one cart before anything is
/// reserved for it.
///
/// The ledger lives only in RAM; [`crate::Engine`] allows nothing until every reservation a
/// previous boot could have made has expired.
#[derive(Debug, Default)]
pub struct Budget(Mutex<Ledger>);

/// What [`Budget::claim`] found for a request.
#[derive(Debug)]
pub enum Claimed<'a> {
    /// The request was answered for this cart.
    Answered(Box<Countersigned>),
    /// The request is bound to this cart; work on it holds the claim.
    Working(ClaimGuard<'a>),
}

/// The id is already bound to another cart.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Replay;

/// A running countersign's hold on its claim. Dropped without an answer, it releases the claim
/// and the request's reservation once no other countersign of the request is running.
#[derive(Debug)]
pub struct ClaimGuard<'a> {
    budget: &'a Budget,
    mandate: [u8; 32],
    request: Ulid,
}

impl Budget {
    /// Binds `request` on `mandate` to `cart_hash`, unless it is bound to another cart. Answers
    /// expired at `now` are forgotten.
    pub fn claim(
        &self,
        mandate: &[u8; 32],
        request: Ulid,
        cart_hash: [u8; 32],
        now: OffsetDateTime,
    ) -> Result<Claimed<'_>, Replay> {
        let mut ledger = self.lock();
        ledger.claims.retain(|_, c| {
            c.running > 0 || c.answer.as_ref().is_none_or(|(until, _)| *until > now)
        });
        let claim = ledger.claims.entry((*mandate, request)).or_insert(Claim {
            cart_hash,
            running: 0,
            answer: None,
        });
        if claim.cart_hash != cart_hash {
            return Err(Replay);
        }
        if let Some((_, out)) = &claim.answer {
            return Ok(Claimed::Answered(Box::new(out.clone())));
        }
        claim.running += 1;
        Ok(Claimed::Working(ClaimGuard {
            budget: self,
            mandate: *mandate,
            request,
        }))
    }

    fn lock(&self) -> MutexGuard<'_, Ledger> {
        // The ledger is consistent after every statement, so a panicked holder leaves it usable.
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl ClaimGuard<'_> {
    /// `max − captured − Σ reservations unexpired at now` on the claim's mandate.
    pub fn left(&self, max: i64, captured_minor: i64, now: OffsetDateTime) -> i64 {
        left(&self.budget.lock(), &self.mandate, max, captured_minor, now)
    }

    /// Reserves `amount` for the claimed cart until `until` if it is within what is
    /// [`Self::left`]; the check and the reservation are one step, so concurrent requests never
    /// reserve past `max`. The request's cart already holding a reservation keeps it.
    pub fn reserve(
        &self,
        max: i64,
        captured_minor: i64,
        amount: i64,
        now: OffsetDateTime,
        until: OffsetDateTime,
    ) -> bool {
        let mut ledger = self.budget.lock();
        let cart_hash = ledger.claims[&(self.mandate, self.request)].cart_hash;
        let reserved = ledger.reserved.entry(self.mandate).or_default();
        reserved.retain(|r| r.until > now);
        // The claim binds the request to one cart, so its reservation is for this amount.
        if let Some(r) = reserved.iter().find(|r| r.request == self.request) {
            debug_assert_eq!((r.cart_hash, r.amount), (cart_hash, amount));
            return true;
        }
        if amount > left(&ledger, &self.mandate, max, captured_minor, now) {
            return false;
        }
        ledger
            .reserved
            .entry(self.mandate)
            .or_default()
            .push(Reservation {
                request: self.request,
                cart_hash,
                amount,
                until,
            });
        true
    }

    /// Records `out` as the answer until `until`. A countersign of the same request and cart
    /// that answered first keeps its answer, which is returned.
    pub fn answer(self, until: OffsetDateTime, out: Countersigned) -> Countersigned {
        let mut ledger = self.budget.lock();
        let claim = ledger
            .claims
            .get_mut(&(self.mandate, self.request))
            .expect("a running claim is kept");
        claim.answer.get_or_insert((until, out)).1.clone()
    }
}

impl Drop for ClaimGuard<'_> {
    fn drop(&mut self) {
        let mut ledger = self.budget.lock();
        let key = (self.mandate, self.request);
        let Some(claim) = ledger.claims.get_mut(&key) else {
            return;
        };
        claim.running -= 1;
        if claim.running > 0 || claim.answer.is_some() {
            return;
        }
        ledger.claims.remove(&key);
        if let Some(reserved) = ledger.reserved.get_mut(&self.mandate) {
            reserved.retain(|r| r.request != self.request);
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
        .reserved
        .get(mandate)
        .into_iter()
        .flatten()
        .filter(|r| r.until > now)
        .fold(0i64, |sum, r| sum.saturating_add(r.amount));
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

    fn work(b: &Budget, request: Ulid, cart: u8) -> ClaimGuard<'_> {
        match b.claim(&[1; 32], request, [cart; 32], at(0)).unwrap() {
            Claimed::Working(g) => g,
            Claimed::Answered(_) => panic!("unanswered"),
        }
    }

    #[test]
    fn reservations_count_until_they_expire() {
        let b = Budget::default();
        let (g1, g2) = (work(&b, id(1), 1), work(&b, id(2), 2));
        assert_eq!(g1.left(10_000, 1_000, at(0)), 9_000);
        assert!(g1.reserve(10_000, 1_000, 6_000, at(0), at(900)));
        assert_eq!(g2.left(10_000, 1_000, at(899)), 3_000);
        assert!(!g2.reserve(10_000, 1_000, 3_001, at(899), at(1_799)));
        assert!(g2.reserve(10_000, 1_000, 3_000, at(899), at(1_799)));
        assert_eq!(g2.left(10_000, 1_000, at(900)), 6_000);
    }

    #[test]
    fn a_request_id_is_bound_to_one_cart() {
        let b = Budget::default();
        let g = work(&b, id(1), 1);
        assert_eq!(b.claim(&[1; 32], id(1), [2; 32], at(0)).err(), Some(Replay));
        assert!(g.reserve(10_000, 0, 6_000, at(0), at(900)));
        // The same cart running twice is reserved once.
        let again = work(&b, id(1), 1);
        assert!(again.reserve(10_000, 0, 6_000, at(0), at(900)));
        assert_eq!(again.left(10_000, 0, at(0)), 4_000);
        // The same id on another mandate is another claim.
        assert!(b.claim(&[2; 32], id(1), [2; 32], at(0)).is_ok());
    }

    #[test]
    fn a_claim_dropped_without_an_answer_releases_its_reservation() {
        let b = Budget::default();
        let (g, other) = (work(&b, id(1), 1), work(&b, id(1), 1));
        assert!(g.reserve(10_000, 0, 6_000, at(0), at(900)));
        drop(g);
        // Another countersign of the request still holds it.
        assert_eq!(other.left(10_000, 0, at(0)), 4_000);
        drop(other);
        let fresh = work(&b, id(2), 2);
        assert_eq!(fresh.left(10_000, 0, at(0)), 10_000);
        // And the id is free for another cart.
        assert!(b.claim(&[1; 32], id(1), [3; 32], at(0)).is_ok());
    }
}
