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
