//! The in-memory ledger of requests and the budget their allowed countersigns reserve.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use time::{Duration, OffsetDateTime};
use ulid::Ulid;

use crate::wire::Countersigned;

/// Whether a record expiring at `expires_at` (whole seconds) is live at `now`. A countersign is
/// valid through its `expiresAt` second (`block.timestamp <= expiresAt`), so its record and
/// reservation are held until that second is over.
fn live(expires_at: OffsetDateTime, now: OffsetDateTime) -> bool {
    now < expires_at + Duration::SECOND
}

/// How long a request id's record is kept after the id's timestamp, on the request's clock.
/// [`crate::Engine`] accepts an id only while its own clock is under `id + 900 s − 60 s`, and a
/// leg B request's clock may run up to 2 s ahead of the engine's or 60 s behind it, so a record
/// kept for `900 + 60 + 2` s on any request's clock outlives every moment the id is accepted.
const ID_WINDOW: Duration = Duration::seconds(962);

/// Whether a request id could still be accepted at `now`. Its record is kept that long, past its
/// countersign's expiry, so the id can never be answered twice: two countersigns under one id
/// would prove the signer compromised on-chain.
fn acceptable(request: Ulid, now: OffsetDateTime) -> bool {
    let issued = OffsetDateTime::UNIX_EPOCH + Duration::milliseconds(request.timestamp_ms() as i64);
    now < issued + ID_WINDOW + Duration::SECOND
}

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

/// The most requests the ledger holds at once, across all mandates. Each holds its answer, a few
/// KiB, until it expires, so this bounds the ledger's memory whatever the request rate.
pub const MAX_LIVE_REQUESTS: usize = 4096;

/// Requests and their reservations per mandate, keyed by the mandate challenge `M`. `M` commits
/// to the whole mandate, so two mandates never share a budget even if they reuse a `mid`.
///
/// A request id is bound to the digest of its whole input by its first claim, on one mandate. The
/// record holds the reservation and the answer until the countersign expires, and the binding
/// until the id could no longer be accepted.
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
    /// The request is new and the ledger already holds [`MAX_LIVE_REQUESTS`].
    Full,
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
    /// it to another digest. A live record keeps its own expiry. Records of any mandate expired
    /// at `now` are dropped whole.
    pub fn claim(
        &self,
        mandate: &[u8; 32],
        request: Ulid,
        digest: [u8; 32],
        expires_at: OffsetDateTime,
        now: OffsetDateTime,
    ) -> Result<Claimed<'_>, Replay> {
        let mut ledger = self.lock();
        ledger.retain(|_, records| {
            records
                .retain(|id, r| r.running > 0 || live(r.expires_at, now) || acceptable(*id, now));
            !records.is_empty()
        });
        // A request id is answered once across all mandates.
        if ledger
            .iter()
            .any(|(m, records)| m != mandate && records.contains_key(&request))
        {
            return Err(Replay);
        }
        let known = ledger
            .get(mandate)
            .is_some_and(|records| records.contains_key(&request));
        if !known && ledger.values().map(BTreeMap::len).sum::<usize>() >= MAX_LIVE_REQUESTS {
            return Ok(Claimed::Full);
        }
        let records = ledger.entry(*mandate).or_default();
        let record = records.entry(request).or_insert(Record {
            digest,
            reserved_minor: None,
            expires_at,
            running: 0,
            answer: None,
        });
        if record.digest != digest || !live(record.expires_at, now) {
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

    #[cfg(test)]
    fn requests(&self) -> usize {
        self.lock().values().map(BTreeMap::len).sum()
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

    /// `max − captured − Σ reservations of the other live records` on the request's mandate.
    /// The request's own reservation is left out, so every runner of it decides alike.
    pub fn left(&self, max: i64, captured_minor: i64, now: OffsetDateTime) -> i64 {
        left(
            &self.budget.lock(),
            &self.mandate,
            self.request,
            max,
            captured_minor,
            now,
        )
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
        let room = left(
            &ledger,
            &self.mandate,
            self.request,
            max,
            captured_minor,
            now,
        );
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
    /// its answer, which is returned. A DENY answer holds no reservation.
    pub fn answer(self, out: Countersigned) -> Result<Countersigned, Replay> {
        let mut ledger = self.budget.lock();
        let record = ledger
            .get_mut(&self.mandate)
            .and_then(|records| records.get_mut(&self.request))
            .ok_or(Replay)?;
        let answer = record.answer.get_or_insert_with(|| Box::new(out));
        if answer.countersign.decision != "1" {
            record.reserved_minor = None;
        }
        Ok((**answer).clone())
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
    except: Ulid,
    max: i64,
    captured_minor: i64,
    now: OffsetDateTime,
) -> i64 {
    let reserved = ledger
        .get(mandate)
        .into_iter()
        .flatten()
        .filter(|(id, _)| **id != except)
        .map(|(_, r)| r)
        .filter(|r| live(r.expires_at, now))
        .filter_map(|r| r.reserved_minor)
        .fold(0i64, i64::saturating_add);
    max.saturating_sub(captured_minor).saturating_sub(reserved)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use time::OffsetDateTime;
    use ulid::Ulid;

    use super::{Budget, ClaimGuard, Claimed, MAX_LIVE_REQUESTS, Replay};
    use crate::wire::Countersigned;

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
            Claimed::Answered(_) | Claimed::Full => panic!("unanswered"),
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
        // A record is held through its expiry second.
        let probe = work(&b, id(9), 9, 1_800, 899);
        assert_eq!(probe.left(10_000, 1_000, at(900)), 0);
        assert_eq!(probe.left(10_000, 1_000, at(901)), 6_000);
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
        // A runner does not count its own request's reservation; other requests do.
        assert_eq!(again.left(10_000, 0, at(0)), 10_000);
        assert_eq!(work(&b, id(9), 9, 900, 0).left(10_000, 0, at(0)), 4_000);
        // The same id on another mandate is a replay: an id is answered once.
        assert_eq!(
            b.claim(&[2; 32], id(1), [2; 32], at(900), at(0)).err(),
            Some(Replay)
        );
    }

    #[test]
    fn an_answered_id_stays_bound_until_it_can_no_longer_be_accepted() {
        let b = Budget::default();
        // The id's timestamp is 0, so its record is kept through second 962.
        let g = work(&b, id(1), 1, 60, 0);
        g.answer(deny()).unwrap();
        // Past the countersign's expiry the record still refuses another input under the id.
        let other = b.claim(&[1; 32], id(1), [2; 32], at(900), at(120));
        assert_eq!(other.err(), Some(Replay));
        let elsewhere = b.claim(&[2; 32], id(1), [2; 32], at(900), at(120));
        assert_eq!(elsewhere.err(), Some(Replay));
        // Once the id is out of its window the record is dropped.
        assert!(
            b.claim(&[3; 32], id(2), [3; 32], at(1_000), at(963))
                .is_ok()
        );
        assert_eq!(b.requests(), 0);
    }

    #[test]
    fn a_record_keeps_its_first_expiry_and_its_reservation_expires_with_it() {
        let b = Budget::default();
        let g = work(&b, id(1), 1, 900, 0);
        assert_eq!(g.reserve(10_000, 0, 6_000, at(0)), Ok(true));
        // A later runner of the same request gets the record's expiry, not its own.
        let late = work(&b, id(1), 1, 901, 1);
        assert_eq!(late.expires_at(), at(900));
        assert_eq!(late.left(10_000, 0, at(899)), 10_000);
        // After the record's expiry second its reservation no longer counts.
        let next = work(&b, id(2), 2, 1_800, 901);
        assert_eq!(next.left(10_000, 0, at(900)), 4_000);
        assert_eq!(next.left(10_000, 0, at(901)), 10_000);
        drop((g, late));
        assert_eq!(next.reserve(10_000, 0, 9_400, at(901)), Ok(true));
        let probe = work(&b, id(9), 9, 1_800, 901);
        assert_eq!(probe.left(10_000, 0, at(901)), 600);
    }

    #[test]
    fn a_request_dropped_without_an_answer_releases_its_reservation() {
        let b = Budget::default();
        let (g, other) = (work(&b, id(1), 1, 900, 0), work(&b, id(1), 1, 900, 0));
        assert_eq!(g.reserve(10_000, 0, 6_000, at(0)), Ok(true));
        drop(g);
        // Another countersign of the request still holds it.
        assert_eq!(work(&b, id(9), 9, 900, 0).left(10_000, 0, at(0)), 4_000);
        drop(other);
        let fresh = work(&b, id(2), 2, 900, 0);
        assert_eq!(fresh.left(10_000, 0, at(0)), 10_000);
        // And the id is free for another input.
        assert!(b.claim(&[1; 32], id(1), [3; 32], at(900), at(0)).is_ok());
    }

    /// A signed DENY, which holds no reservation.
    fn deny() -> Countersigned {
        let z = |n: usize| format!("0x{}", "0".repeat(n));
        serde_json::from_value(json!({
            "countersign": {
                "requestId": z(64), "mandateHash": z(64), "mandateCommitment": z(64),
                "cartHash": z(64), "agentId": "0", "merchantId": z(64), "amount": "0",
                "currency": "840", "category": "0", "evidenceRoot": z(64), "evalHash": z(64),
                "policySetHash": z(64), "decision": "2", "failedFieldsMask": "1",
                "issuedAt": "0", "expiresAt": "0"
            },
            "digest": z(64), "signature": z(130), "signer": z(40), "tee": 1, "trace_jcs": "",
            "observation": {
                "now_ms": 0, "budget_left_minor": 0,
                "user_key": {
                    "kty": "EC", "crv": "P-256",
                    "x": "rG2YAN80tmhPdXxOOH_ZsBqdI97Cf4yJL3H8ZToyX-M",
                    "y": "uIq1dTwXYVvt26u9ehj7Itc4yr0f0N89hi4tBE2PVdk"
                },
                "paypal": {
                    "authorization_id": "", "status": "", "currency": "", "authorized_minor": 0,
                    "captured_minor": 0, "payee_merchant_id": "", "expires_at_ms": 0,
                    "custom_id": "", "raw_authorization": "", "raw_order": "", "read_at_ms": 0
                }
            }
        }))
        .unwrap()
    }

    fn answered(b: &Budget, mandate: u8, request: Ulid, expires: i64, now: i64) {
        let Ok(Claimed::Working(g)) =
            b.claim(&[mandate; 32], request, [1; 32], at(expires), at(now))
        else {
            panic!("not claimed");
        };
        g.answer(deny()).unwrap();
    }

    #[test]
    fn expired_requests_of_every_mandate_are_dropped() {
        let b = Budget::default();
        answered(&b, 1, id(1), 900, 0);
        answered(&b, 2, id(2), 1_800, 0);
        assert_eq!(b.requests(), 2);
        // A claim on any mandate drops what expired on every other one.
        answered(&b, 3, id(3), 2_700, 963);
        assert_eq!(b.requests(), 2);
    }

    #[test]
    fn a_full_ledger_refuses_new_requests_until_some_expire() {
        let b = Budget::default();
        let held: Vec<_> = (0..MAX_LIVE_REQUESTS as u128)
            .map(|n| work(&b, id(n), 1, 900, 0))
            .collect();
        assert!(matches!(
            b.claim(
                &[2; 32],
                id(MAX_LIVE_REQUESTS as u128),
                [1; 32],
                at(900),
                at(0)
            ),
            Ok(Claimed::Full)
        ));
        // A request already in the ledger is still answered.
        assert!(matches!(
            b.claim(&[1; 32], id(0), [1; 32], at(900), at(0)),
            Ok(Claimed::Working(_))
        ));
        drop(held);
        assert!(matches!(
            b.claim(
                &[2; 32],
                id(MAX_LIVE_REQUESTS as u128),
                [1; 32],
                at(900),
                at(0)
            ),
            Ok(Claimed::Working(_))
        ));
    }
}
