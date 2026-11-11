//! The card authorizations each leg answered, and what leg A counts as spent on a card mandate.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use crate::EngineError;
use crate::wire::CardAuthorized;

/// Most cards and card mandates the ledger keeps at once; past it, new approvals are refused.
const MAX_ENTRIES: usize = 65_536;

/// The `failedMask` bits of a `CardAuthorization`. Append-only.
pub const CARD_BITS: [(&str, u8); 9] = [
    ("decision", 0),
    ("rail", 1),
    ("expired", 2),
    ("currency", 3),
    ("amount", 4),
    ("mcc", 5),
    ("country", 6),
    ("merchant", 7),
    ("used", 8),
];

/// The mask bit of `name` in [`CARD_BITS`].
pub(crate) fn card_bit(name: &str) -> u32 {
    let (_, bit) = CARD_BITS
        .iter()
        .find(|(n, _)| *n == name)
        .expect("a card bit");
    1 << bit
}

struct Answer {
    authorization_id: String,
    out: CardAuthorized,
    forget_at: i64,
}

#[derive(Default)]
struct Ledger {
    /// The approved authorization of each card, by the request id of the ALLOW it was issued under.
    answered: HashMap<[u8; 32], Answer>,
    /// Minor units approved on the cards of each mandate, and when the mandate expires.
    spent: HashMap<[u8; 32], (i64, i64)>,
}

impl Ledger {
    fn prune(&mut self, now: i64) {
        self.answered.retain(|_, a| a.forget_at > now);
        self.spent.retain(|_, (_, exp)| *exp > now);
    }
}

/// A signed answer and, for an approval, what the ledger records.
pub(crate) struct Approval {
    pub(crate) out: CardAuthorized,
    pub(crate) approves: bool,
    pub(crate) mandate_hash: [u8; 32],
    pub(crate) mandate_exp: i64,
    pub(crate) amount: i64,
    /// When the card's single use may be forgotten: once the card can no longer be authorized.
    pub(crate) forget_at: i64,
}

/// Single use of each card, and what each card mandate spent. Kept in memory: after a restart
/// the issuer's own controls (per-card limit, per-cardholder limit, card cancelled after use)
/// still bound every card.
#[derive(Default)]
pub(crate) struct CardLedger(Mutex<Ledger>);

impl CardLedger {
    fn lock(&self) -> MutexGuard<'_, Ledger> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Answers an authorization of the card issued under `request_id`: the same answer for the
    /// authorization it approved before, otherwise `decide(used)`, where `used` says the card
    /// already approved another one. An approval is recorded under the same lock, so two
    /// authorizations of one card cannot both pass.
    pub(crate) fn decide(
        &self,
        request_id: [u8; 32],
        authorization_id: &str,
        now: i64,
        decide: impl FnOnce(bool) -> Result<Approval, EngineError>,
    ) -> Result<CardAuthorized, EngineError> {
        let mut ledger = self.lock();
        ledger.prune(now);
        let used = match ledger.answered.get(&request_id) {
            Some(a) if a.authorization_id == authorization_id => return Ok(a.out.clone()),
            Some(_) => true,
            None => false,
        };
        let a = decide(used)?;
        if a.approves {
            if ledger.answered.len() >= MAX_ENTRIES || ledger.spent.len() >= MAX_ENTRIES {
                return Err(EngineError::Busy);
            }
            let spent = ledger
                .spent
                .entry(a.mandate_hash)
                .or_insert((0, a.mandate_exp));
            spent.0 = spent.0.saturating_add(a.amount);
            ledger.answered.insert(
                request_id,
                Answer {
                    authorization_id: authorization_id.to_owned(),
                    out: a.out.clone(),
                    forget_at: a.forget_at,
                },
            );
        }
        Ok(a.out)
    }

    /// Minor units approved on the cards of the mandate whose challenge is `mandate_hash`.
    pub(crate) fn spent(&self, mandate_hash: &[u8; 32], now: i64) -> i64 {
        let mut ledger = self.lock();
        ledger.prune(now);
        ledger.spent.get(mandate_hash).map_or(0, |(n, _)| *n)
    }
}

/// The seal purpose of a card's single use: the authorization it approved.
const CARD_USE_PURPOSE: &str = "keelson/seal/card-use/v1";
/// The seal purpose of one approved card charge of a mandate: its request id and amount.
const CARD_SPEND_PURPOSE: &str = "keelson/seal/card-spend/v1";
/// Most approved card charges one mandate keeps.
const MAX_SPENDS: usize = 4_096;
/// Missing slots in a row after which a mandate's charges end; fewer are holes.
const MAX_GAP: usize = 16;

/// Leg A's durable record of each card's single use and of what each card mandate's cards
/// approved, sealed with the KMS root in the user records. The records survive a restart, so a
/// card is never approved twice and a card mandate's budget never refills. A record that is
/// missing, which only the host can cause, is a gap the issuer's own per-card limits bound.
pub(crate) struct DurableCards<'a> {
    pub(crate) root: &'a crate::Root,
    pub(crate) users: &'a dyn crate::UserRecords,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl DurableCards<'_> {
    /// Records that the card issued under `request_id` approved `authorization_id`, unless it
    /// already approved another; says whether this authorization is the card's use.
    pub(crate) fn claim_use(&self, request_id: &[u8; 32], authorization_id: &str) -> bool {
        let aad = crate::SealAad {
            purpose: CARD_USE_PURPOSE,
            sub: None,
            record: request_id,
        };
        let key = format!("card-use\0{}", hex(request_id));
        let ours = |blob: Vec<u8>| {
            self.root
                .unseal(&aad, &blob)
                .is_ok_and(|id| id == authorization_id.as_bytes())
        };
        match self.users.get(&key) {
            Some(blob) => ours(blob),
            None => {
                self.users
                    .insert_new(&key, self.root.seal(&aad, authorization_id.as_bytes()))
                    || self.users.get(&key).is_some_and(ours)
            }
        }
    }

    fn spend_key(mandate_hash: &[u8; 32], n: usize) -> String {
        format!("card-spend\0{}\0{n}", hex(mandate_hash))
    }

    fn spend_record(mandate_hash: &[u8; 32], n: usize) -> Vec<u8> {
        [&mandate_hash[..], &n.to_be_bytes()].concat()
    }

    fn open(&self, mandate_hash: &[u8; 32], n: usize, blob: &[u8]) -> Option<([u8; 32], i64)> {
        let record = Self::spend_record(mandate_hash, n);
        let aad = crate::SealAad {
            purpose: CARD_SPEND_PURPOSE,
            sub: None,
            record: &record,
        };
        let plain = self.root.unseal(&aad, blob).ok()?;
        let (id, amount) = plain.split_at_checked(32)?;
        Some((
            id.try_into().ok()?,
            i64::from_be_bytes(amount.try_into().ok()?),
        ))
    }

    /// Appends the approved charge of the card issued under `request_id` to the mandate's
    /// charges, once.
    pub(crate) fn record_spend(
        &self,
        mandate_hash: &[u8; 32],
        request_id: &[u8; 32],
        amount: i64,
    ) -> bool {
        for n in 0..MAX_SPENDS {
            let key = Self::spend_key(mandate_hash, n);
            if let Some(blob) = self.users.get(&key) {
                if self
                    .open(mandate_hash, n, &blob)
                    .is_some_and(|(id, _)| &id == request_id)
                {
                    return true;
                }
                continue;
            }
            let record = Self::spend_record(mandate_hash, n);
            let aad = crate::SealAad {
                purpose: CARD_SPEND_PURPOSE,
                sub: None,
                record: &record,
            };
            let plain = [&request_id[..], &amount.to_be_bytes()].concat();
            if self.users.insert_new(&key, self.root.seal(&aad, &plain)) {
                return true;
            }
        }
        false
    }

    /// Every approved charge of the mandate's cards, by request id. A record that does not open,
    /// or a slot missing below a later record, counts as the most it could be, so a record the
    /// host altered or removed spends the budget instead of refilling it.
    pub(crate) fn spends(&self, mandate_hash: &[u8; 32]) -> Vec<([u8; 32], i64)> {
        let mut out = Vec::new();
        let mut missing = 0;
        for n in 0..MAX_SPENDS {
            let Some(blob) = self.users.get(&Self::spend_key(mandate_hash, n)) else {
                missing += 1;
                if missing == MAX_GAP {
                    break;
                }
                continue;
            };
            out.extend(std::iter::repeat_n(([0; 32], i64::MAX), missing));
            missing = 0;
            out.push(
                self.open(mandate_hash, n, &blob)
                    .unwrap_or(([0; 32], i64::MAX)),
            );
        }
        out
    }
}
