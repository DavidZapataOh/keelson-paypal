//! Dispute attribution: an ordered decision list compiled to one Cedar policy set per liable
//! party. Rule *k* is a `permit` whose condition is its own and the negation of every earlier
//! rule's, so the first matching rule decides and the sets never overlap.

use std::fmt;
use std::str::FromStr;
use std::sync::OnceLock;

use cedar_policy::{
    Authorizer, Context, Entities, EntityUid, Policy, PolicyId, PolicySet, Request, Schema,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// The attribution schema source, `policy/attribution.cedarschema`.
pub const ATTRIBUTION_SCHEMA_SRC: &str = include_str!("../policy/attribution.cedarschema");

/// The reason of a PayPal dispute: the `dispute_reason` enum of the Disputes v1 API.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Reason {
    MerchandiseOrServiceNotReceived,
    MerchandiseOrServiceNotAsDescribed,
    Unauthorised,
    CreditNotProcessed,
    DuplicateTransaction,
    IncorrectAmount,
    PaymentByOtherMeans,
    CanceledRecurringBilling,
    ProblemWithRemittance,
    Other,
}

impl Reason {
    pub const ALL: [Self; 10] = [
        Self::MerchandiseOrServiceNotReceived,
        Self::MerchandiseOrServiceNotAsDescribed,
        Self::Unauthorised,
        Self::CreditNotProcessed,
        Self::DuplicateTransaction,
        Self::IncorrectAmount,
        Self::PaymentByOtherMeans,
        Self::CanceledRecurringBilling,
        Self::ProblemWithRemittance,
        Self::Other,
    ];

    /// The PayPal value, which is also the `Keelson::Reason` entity id.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::MerchandiseOrServiceNotReceived => "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
            Self::MerchandiseOrServiceNotAsDescribed => "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
            Self::Unauthorised => "UNAUTHORISED",
            Self::CreditNotProcessed => "CREDIT_NOT_PROCESSED",
            Self::DuplicateTransaction => "DUPLICATE_TRANSACTION",
            Self::IncorrectAmount => "INCORRECT_AMOUNT",
            Self::PaymentByOtherMeans => "PAYMENT_BY_OTHER_MEANS",
            Self::CanceledRecurringBilling => "CANCELED_RECURRING_BILLING",
            Self::ProblemWithRemittance => "PROBLEM_WITH_REMITTANCE",
            Self::Other => "OTHER",
        }
    }
}

/// Who pays for a dispute. The discriminant is the `liable` code of the `Verdict` message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[repr(u8)]
pub enum Liable {
    /// The agent's operator: the dispute is accepted and the operator's bond is slashed.
    Operator = 1,
    /// Keelson: the dispute is accepted and the warranty reserve pays.
    Keelson = 2,
    /// The merchant: evidence that the agent complied, and PayPal resolves against the merchant.
    Merchant = 3,
    /// The user: evidence, with the Alibi, that the purchase was the one the user authorized.
    User = 4,
}

impl Liable {
    pub const ALL: [Self; 4] = [Self::Operator, Self::Keelson, Self::Merchant, Self::User];

    /// The `@liable` annotation value.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Operator => "operator",
            Self::Keelson => "keelson",
            Self::Merchant => "merchant",
            Self::User => "user",
        }
    }
}

/// What the host establishes about a dispute from the PayPal dispute and the purchase's proofs:
/// the `attribute` context. `failed_*` come from re-running the engine on the countersigned
/// context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Facts {
    pub reason: Reason,
    /// The mandate, the countersignature, the log inclusion and the attestation all verify.
    pub proof_valid: bool,
    pub failed_green: bool,
    pub failed_amber: bool,
    pub failed_gray: bool,
    pub captured_eq_countersigned: bool,
    /// Keelson countersigned a single-use mandate twice.
    pub duplicate_countersig: bool,
    /// More than one capture under one countersignature.
    pub duplicate_capture: bool,
    pub tracking_delivered: bool,
    pub snapshot_matches_item: bool,
    pub refund_recorded: bool,
}

/// One entry of the decision list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rule {
    /// `R<id>` in the table, and the `ruleId` of the `Verdict`.
    pub id: u8,
    pub liable: Liable,
    /// The rule's own condition, a Cedar expression over `context`.
    pub when: &'static str,
}

impl Rule {
    /// `R00`, `R10`, …
    pub fn name(&self) -> String {
        format!("R{:02}", self.id)
    }
}

macro_rules! reason {
    ($r:literal) => {
        concat!("context.reason == Keelson::Reason::\"", $r, "\"")
    };
}

/// The attribution table, in order: the first rule whose condition holds decides.
pub const RULES: [Rule; 15] = [
    Rule {
        id: 0,
        liable: Liable::Operator,
        when: "!context.proof_valid",
    },
    Rule {
        id: 10,
        liable: Liable::User,
        when: concat!(
            reason!("MERCHANDISE_OR_SERVICE_NOT_RECEIVED"),
            " && context.tracking_delivered"
        ),
    },
    Rule {
        id: 11,
        liable: Liable::Merchant,
        when: reason!("MERCHANDISE_OR_SERVICE_NOT_RECEIVED"),
    },
    Rule {
        id: 20,
        liable: Liable::User,
        when: concat!(
            reason!("CREDIT_NOT_PROCESSED"),
            " && context.refund_recorded"
        ),
    },
    Rule {
        id: 21,
        liable: Liable::Merchant,
        when: reason!("CREDIT_NOT_PROCESSED"),
    },
    Rule {
        id: 30,
        liable: Liable::Keelson,
        when: concat!(
            reason!("DUPLICATE_TRANSACTION"),
            " && context.duplicate_countersig"
        ),
    },
    Rule {
        id: 31,
        liable: Liable::Operator,
        when: concat!(
            reason!("DUPLICATE_TRANSACTION"),
            " && context.duplicate_capture"
        ),
    },
    Rule {
        id: 32,
        liable: Liable::User,
        when: reason!("DUPLICATE_TRANSACTION"),
    },
    Rule {
        id: 35,
        liable: Liable::Merchant,
        when: concat!(
            reason!("PAYMENT_BY_OTHER_MEANS"),
            " || ",
            reason!("CANCELED_RECURRING_BILLING"),
            " || ",
            reason!("PROBLEM_WITH_REMITTANCE")
        ),
    },
    Rule {
        id: 40,
        liable: Liable::Merchant,
        when: concat!(
            reason!("INCORRECT_AMOUNT"),
            " && !context.captured_eq_countersigned"
        ),
    },
    Rule {
        id: 50,
        liable: Liable::Merchant,
        when: concat!(
            reason!("MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"),
            " && !context.snapshot_matches_item"
        ),
    },
    Rule {
        id: 60,
        liable: Liable::Keelson,
        when: "context.failed_green",
    },
    Rule {
        id: 61,
        liable: Liable::Operator,
        when: "context.failed_amber",
    },
    Rule {
        id: 62,
        liable: Liable::User,
        when: "context.failed_gray",
    },
    Rule {
        id: 70,
        liable: Liable::User,
        when: "!context.failed_green && !context.failed_amber && !context.failed_gray",
    },
];

/// The Cedar text of `rules` as a decision list: each rule a `permit` annotated with `@id` and
/// `@liable`, guarded by the negation of every earlier rule.
pub fn attribution_policy_text(rules: &[Rule]) -> String {
    policy_text(rules, true)
}

/// [`attribution_policy_text`], or with `precedence` off, each rule on its own condition only.
pub(crate) fn policy_text(rules: &[Rule], precedence: bool) -> String {
    let mut out = String::new();
    for (k, rule) in rules.iter().enumerate() {
        let mut when = format!("({})", rule.when);
        if precedence {
            for earlier in &rules[..k] {
                when.push_str(&format!(" && !({})", earlier.when));
            }
        }
        out.push_str(&format!(
            "@id(\"{}\")\n@liable(\"{}\")\npermit(principal, action == Keelson::Action::\"attribute\", resource)\nwhen {{ {when} }};\n\n",
            rule.name(),
            rule.liable.as_str()
        ));
    }
    out
}

/// One policy set per liable party, in [`Liable::ALL`] order, from Cedar text whose policies
/// carry `@id` and `@liable`. Each policy id is its `@id`.
pub(crate) fn sets_from_text(text: &str) -> Vec<(Liable, PolicySet)> {
    let parsed = PolicySet::from_str(text).expect("the attribution policies parse");
    Liable::ALL
        .into_iter()
        .map(|liable| {
            let policies = parsed
                .policies()
                .filter(|p| p.annotation("liable") == Some(liable.as_str()))
                .map(|p| {
                    let id = p.annotation("id").expect("every rule has an @id");
                    Policy::parse(Some(PolicyId::new(id)), p.to_string())
                        .expect("a parsed policy parses again")
                });
            let set = PolicySet::from_policies(policies).expect("rule ids are unique");
            (liable, set)
        })
        .collect()
}

/// The generated text of [`RULES`].
pub fn attribution_policy_src() -> &'static str {
    static TEXT: OnceLock<String> = OnceLock::new();
    TEXT.get_or_init(|| attribution_policy_text(&RULES))
}

/// The policy sets of [`RULES`], one per liable party in [`Liable::ALL`] order.
pub fn attribution_sets() -> &'static [(Liable, PolicySet)] {
    static SETS: OnceLock<Vec<(Liable, PolicySet)>> = OnceLock::new();
    SETS.get_or_init(|| sets_from_text(attribution_policy_src()))
}

/// The parsed attribution schema.
pub fn attribution_schema() -> &'static Schema {
    static SCHEMA: OnceLock<Schema> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        Schema::from_cedarschema_str(ATTRIBUTION_SCHEMA_SRC)
            .expect("the attribution schema parses")
            .0
    })
}

/// SHA-256 of [`attribution_policy_src`].
pub fn attribution_policy_set_hash() -> [u8; 32] {
    Sha256::digest(attribution_policy_src()).into()
}

/// SHA-256 of the attribution schema file bytes.
pub fn attribution_schema_hash() -> [u8; 32] {
    Sha256::digest(ATTRIBUTION_SCHEMA_SRC).into()
}

/// The party that pays for a dispute and the rule that decided it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Attribution {
    pub rule: u8,
    pub liable: Liable,
}

/// Why a dispute could not be attributed. The proofs rule out all but `Cedar`; the evaluator
/// checks anyway and fails closed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttributionError {
    /// Cedar rejected the request or reported an evaluation error.
    Cedar(String),
    /// No rule matched.
    Unattributed,
    /// More than one rule matched, named here.
    Ambiguous(Vec<String>),
}

impl fmt::Display for AttributionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cedar(e) => write!(f, "cedar: {e}"),
            Self::Unattributed => f.write_str("no attribution rule matched"),
            Self::Ambiguous(rules) => write!(f, "attribution rules overlap: {}", rules.join(", ")),
        }
    }
}

impl std::error::Error for AttributionError {}

/// `facts` as the `attribute` context in Cedar JSON form.
pub(crate) fn context_json(facts: &Facts) -> Value {
    let mut context = serde_json::to_value(facts).expect("facts serialize");
    context["reason"] =
        json!({ "__entity": { "type": "Keelson::Reason", "id": facts.reason.as_str() } });
    context
}

/// The `attribute` request for `facts`.
fn request(facts: &Facts) -> Result<Request, AttributionError> {
    let cedar = |e: &dyn fmt::Display| AttributionError::Cedar(e.to_string());
    let schema = attribution_schema();
    let dispute = EntityUid::from_str(r#"Keelson::Dispute::"dispute""#).map_err(|e| cedar(&e))?;
    let action = EntityUid::from_str(r#"Keelson::Action::"attribute""#).map_err(|e| cedar(&e))?;
    let context = Context::from_json_value(context_json(facts), Some((schema, &action)))
        .map_err(|e| cedar(&e))?;
    Request::new(dispute.clone(), action, dispute, context, Some(schema)).map_err(|e| cedar(&e))
}

/// The rule that attributes `facts`, evaluated by Cedar over [`attribution_sets`]. Fails unless
/// exactly one rule in exactly one set allows the request with no evaluation error.
pub fn attribute(facts: &Facts) -> Result<Attribution, AttributionError> {
    let request = request(facts)?;
    let entities = Entities::empty();
    let authorizer = Authorizer::new();
    let mut fired = Vec::new();
    for (liable, set) in attribution_sets() {
        let response = authorizer.is_authorized(&request, set, &entities);
        let errors: Vec<_> = response
            .diagnostics()
            .errors()
            .map(ToString::to_string)
            .collect();
        if !errors.is_empty() {
            return Err(AttributionError::Cedar(errors.join("; ")));
        }
        fired.extend(
            response
                .diagnostics()
                .reason()
                .map(|id| (*liable, id.to_string())),
        );
    }
    match fired.as_slice() {
        [] => Err(AttributionError::Unattributed),
        [(liable, id)] => Ok(Attribution {
            rule: id[1..].parse().expect("rule ids are R<number>"),
            liable: *liable,
        }),
        _ => Err(AttributionError::Ambiguous(
            fired.into_iter().map(|(_, id)| id).collect(),
        )),
    }
}
