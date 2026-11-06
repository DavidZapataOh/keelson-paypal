use std::fmt::Display;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use std::{env, io};

use cedar_policy::{
    Authorizer, Context, Effect, Entities, EntityUid, Policy, PolicyId, PolicySet, Request,
};
use cedar_policy_symcc::err::Error;
use cedar_policy_symcc::solver::{LocalSolver, SolverError};
use cedar_policy_symcc::{CedarSymCompiler, CompiledPolicy, CompiledPolicySet, Env};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::extras::{Extra, compile};
use crate::hashes::hex;
use crate::{
    Decision, PolicyError, policies, policy_set_hash_tag, policy_texts, schema, schema_hash_tag,
};

/// The reference spec source, `policy/spec.cedar`: one `permit` stating every mandate rule.
pub const SPEC_SRC: &str = include_str!("../policy/spec.cedar");
/// The `cedar-policy-symcc` version in `Cargo.lock`.
pub const SYMCC_VERSION: &str = env!("KEELSON_SYMCC_VERSION");
/// The `cedar-policy` version in `Cargo.lock`.
pub const CEDAR_POLICY_VERSION: &str = env!("KEELSON_CEDAR_POLICY_VERSION");
/// The cvc5 release `cedar-policy-symcc` [`SYMCC_VERSION`] is built and verified against.
pub const CVC5_VERSION: &str = "1.3.1";

/// A cvc5 binary of version [`CVC5_VERSION`].
#[derive(Debug, Clone)]
pub struct Cvc5 {
    path: PathBuf,
    version: String,
}

impl Cvc5 {
    /// The binary named by the `CVC5` environment variable, else `cvc5` on `PATH`: the lookup
    /// symcc's `LocalSolver::cvc5` uses. Fails unless it reports version [`CVC5_VERSION`].
    pub fn from_env() -> io::Result<Self> {
        let name = env::var_os("CVC5").map_or_else(|| PathBuf::from("cvc5"), PathBuf::from);
        let path = resolve(&name)?;
        let with_path = |e: io::Error| io::Error::new(e.kind(), format!("{}: {e}", path.display()));
        let out = std::process::Command::new(&path)
            .arg("--version")
            .output()
            .map_err(with_path)?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        let version = stdout
            .lines()
            .next()
            .and_then(|l| l.strip_prefix("This is cvc5 version "))
            .and_then(|rest| rest.split_whitespace().next())
            .unwrap_or_default()
            .to_owned();
        if version != CVC5_VERSION {
            return Err(io::Error::other(format!(
                "{}: cvc5 {CVC5_VERSION} is required, found {version:?}",
                path.display()
            )));
        }
        Ok(Self { path, version })
    }

    /// The binary that is run.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The version the binary reports.
    pub fn version(&self) -> &str {
        &self.version
    }

    /// An interactive solver process, with the arguments `LocalSolver::cvc5` passes.
    fn spawn(&self) -> Result<LocalSolver, SolverError> {
        LocalSolver::from_command(tokio::process::Command::new(&self.path).args([
            "--lang",
            "smt",
            "--tlimit=60000",
        ]))
    }
}

/// `name` as given if it is a path, else its first match on `PATH`.
fn resolve(name: &Path) -> io::Result<PathBuf> {
    if name.components().count() > 1 {
        return Ok(name.to_owned());
    }
    env::var_os("PATH")
        .iter()
        .flat_map(env::split_paths)
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("{}: not found on PATH", name.display()),
            )
        })
}

/// The outcome of one check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    /// The property holds on every well-formed request and entity store.
    Verified,
    /// The property fails.
    Counterexample,
}

/// One check and its verdict.
#[derive(Debug, Clone, Serialize)]
pub struct ProofResult {
    pub check: String,
    pub subject: String,
    pub verdict: Verdict,
    /// A request and entity store on which the property fails, in Cedar's JSON forms, when the
    /// solver produces one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub counterexample: Option<Value>,
    /// A request the property is shown on, in the same form: an allowed one for `satisfiable`,
    /// a denied one for `not_always_allows`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub witness: Option<Value>,
    /// Wall time of the check, symbolic compilation included. Not serialized, so the bundle is reproducible.
    #[serde(skip)]
    pub elapsed: Duration,
}

/// The checks run on the policy set, and the exact inputs and tools they ran on.
#[derive(Debug, Clone, Serialize)]
pub struct ProofBundle {
    pub symcc: String,
    pub cvc5: String,
    pub cedar_policy: String,
    pub policy_set_hash: String,
    pub schema_hash: String,
    pub spec_hash: String,
    pub results: Vec<ProofResult>,
}

/// `sha256:<hex>` of the spec file bytes.
pub fn spec_hash_tag() -> String {
    hex("sha256:", &Sha256::digest(SPEC_SRC))
}

/// The parsed reference spec, [`SPEC_SRC`].
pub fn spec() -> &'static PolicySet {
    static SPEC: OnceLock<PolicySet> = OnceLock::new();
    SPEC.get_or_init(|| PolicySet::from_str(SPEC_SRC).expect("the bundled spec parses"))
}

/// Runs every check of [`prove_set`] on the policy set and records the inputs and tools.
pub fn prove_all(solver: &Cvc5) -> Result<ProofBundle, Box<Error>> {
    Ok(ProofBundle {
        symcc: SYMCC_VERSION.to_owned(),
        cvc5: solver.version().to_owned(),
        cedar_policy: CEDAR_POLICY_VERSION.to_owned(),
        policy_set_hash: policy_set_hash_tag(),
        schema_hash: schema_hash_tag(),
        spec_hash: spec_hash_tag(),
        results: prove_set(solver, policies())?,
    })
}

/// Runs every check on `set`, over every request environment of the schema. Each subject is
/// prefixed with the environment's action id.
///
/// - `equivalent`: `set` and the spec decide every request the same way;
/// - `never_errors`: each `forbid` in `set`, and a policy of each [`Extra`] kind, never errors;
/// - `satisfiable`: some request is allowed (`set` does not always deny);
/// - `not_always_allows`: some request is denied.
///
/// The last two keep the equivalence from holding vacuously. Their witnesses are drawn from the
/// requests whose integers are all safe JSON integers, the only ones the engine builds, so the
/// bundle stays canonical JSON.
pub fn prove_set(solver: &Cvc5, set: &PolicySet) -> Result<Vec<ProofResult>, Box<Error>> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| Error::from(SolverError::from(e)))?
        .block_on(check(solver, set, spec()))
}

/// A policy of each extra kind. Extras compare a context attribute with a literal and do no
/// arithmetic, so whether one errors does not depend on the literal.
fn extra_kinds() -> Vec<(&'static str, Extra)> {
    vec![
        ("extra:max_unit_price", Extra::MaxUnitPrice { minor: 5000 }),
        (
            "extra:deny_merchant",
            Extra::DenyMerchant {
                id: "mrc_runfast".to_owned(),
            },
        ),
        (
            "extra:deny_category",
            Extra::DenyCategory {
                id: "gpt:187".to_owned(),
            },
        ),
        (
            "extra:require_return_days",
            Extra::RequireReturnDays { min: 30 },
        ),
    ]
}

/// The `Long` attributes of the `checkout` context and of the `Mandate` entity.
const LONGS: [&str; 11] = [
    "context.total_minor",
    "context.max_line_qty",
    "context.max_unit_minor",
    "context.return_days",
    "context.now_ms",
    "resource.max_total_minor",
    "resource.budget_left_minor",
    "resource.max_qty_per_line",
    "resource.not_before_ms",
    "resource.expires_at_ms",
    "resource.min_return_days",
];

/// A `permit` for every request whose [`LONGS`] are safe JSON integers.
fn safe_integers() -> PolicySet {
    let max = crate::MAX_SAFE_INTEGER;
    let bounds: Vec<_> = LONGS
        .iter()
        .map(|a| format!("-{max} <= {a} && {a} <= {max}"))
        .collect();
    let text = format!(
        r#"permit(principal, action == Keelson::Action::"checkout", resource) when {{ {} }};"#,
        bounds.join(" && ")
    );
    PolicySet::from_str(&text).expect("the safe-integer policy parses")
}

async fn check(
    solver: &Cvc5,
    set: &PolicySet,
    spec: &PolicySet,
) -> Result<Vec<ProofResult>, Box<Error>> {
    let schema = schema();
    let (names, kinds): (Vec<_>, Vec<_>) = extra_kinds().into_iter().unzip();
    let extras = compile(&kinds).expect("each extra kind compiles");
    let safe = safe_integers();
    let mut symcc = CedarSymCompiler::new(solver.spawn().map_err(Error::from)?)?;
    let mut results = Vec::new();
    for env in schema.request_envs() {
        let action = env.action().id().unescaped();
        let subject = |name: &str| format!("{action}/{name}");
        let t = Instant::now();
        let compiled = CompiledPolicySet::compile(set, &env, schema)?;
        let compiled_spec = CompiledPolicySet::compile(spec, &env, schema)?;
        let cex = symcc
            .check_equivalent_with_counterexample_opt(&compiled, &compiled_spec)
            .await?;
        results.push(result("equivalent", &subject("policy_set=spec"), cex, t));

        let forbids = set
            .policies()
            .filter(|p| p.effect() == Effect::Forbid)
            .map(|p| (p.id().to_string(), p));
        let extras = names
            .iter()
            .zip(&extras)
            .map(|(name, (_, p, _))| ((*name).to_owned(), p));
        for (name, policy) in forbids.chain(extras) {
            let t = Instant::now();
            let compiled = CompiledPolicy::compile(policy, &env, schema)?;
            let cex = symcc
                .check_never_errors_with_counterexample_opt(&compiled)
                .await?;
            results.push(result("never_errors", &subject(&name), cex, t));
        }

        let compiled_safe = CompiledPolicySet::compile(&safe, &env, schema)?;
        let t = Instant::now();
        let allowed = symcc
            .check_disjoint_with_counterexample_opt(&compiled, &compiled_safe)
            .await?;
        results.push(witnessed("satisfiable", &subject("policy_set"), allowed, t));

        let t = Instant::now();
        let denied = symcc
            .check_implies_with_counterexample_opt(&compiled_safe, &compiled)
            .await?;
        results.push(witnessed(
            "not_always_allows",
            &subject("policy_set"),
            denied,
            t,
        ));
    }
    symcc.solver_mut().clean_up().await.map_err(Error::from)?;
    Ok(results)
}

fn result(check: &str, subject: &str, cex: Option<Env>, started: Instant) -> ProofResult {
    let elapsed = started.elapsed();
    ProofResult {
        check: check.to_owned(),
        subject: subject.to_owned(),
        verdict: if cex.is_some() {
            Verdict::Counterexample
        } else {
            Verdict::Verified
        },
        counterexample: cex.as_ref().map(counterexample),
        witness: None,
        elapsed,
    }
}

/// The result of a check that holds when the solver finds a witness request.
fn witnessed(check: &str, subject: &str, witness: Option<Env>, started: Instant) -> ProofResult {
    let elapsed = started.elapsed();
    ProofResult {
        check: check.to_owned(),
        subject: subject.to_owned(),
        verdict: if witness.is_some() {
            Verdict::Verified
        } else {
            Verdict::Counterexample
        },
        counterexample: None,
        witness: witness.as_ref().map(counterexample),
        elapsed,
    }
}

/// `{ principal, action, resource, context, entities }` in Cedar's JSON forms, entities sorted by
/// uid so the value does not depend on hash order.
fn counterexample(env: &Env) -> Value {
    let uid =
        |u: Option<&EntityUid>| u.map(|u| u.to_json_value().expect("an entity uid serializes"));
    let request = &env.request;
    let mut entities = match env
        .entities
        .to_json_value()
        .expect("concrete entities serialize")
    {
        Value::Array(entities) => entities,
        other => vec![other],
    };
    entities.sort_by_key(|e| e["uid"].to_string());
    json!({
        "principal": uid(request.principal()),
        "action": uid(request.action()),
        "resource": uid(request.resource()),
        "context": request
            .context()
            .map(|c| c.to_json_value().expect("a concrete context serializes")),
        "entities": entities,
    })
}

/// A known policy bug, seeded into the policy set to show the checks catch it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedBug {
    /// The `amount` forbid compares `total + 1` with `max + 1`. The addition can overflow, an
    /// erroring `forbid` is skipped, and the `permit` lets a cart over the maximum through.
    Overflow,
    /// A blanket `permit` added to a set without the `agent` forbid: any agent can spend the
    /// mandate.
    ExtraPermit,
}

impl SeedBug {
    /// `overflow` or `extra-permit`.
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "overflow" => Some(Self::Overflow),
            "extra-permit" => Some(Self::ExtraPermit),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Overflow => "overflow",
            Self::ExtraPermit => "extra-permit",
        }
    }

    /// The policy set with the bug seeded, built from [`policies`].
    pub fn policy_set(self) -> PolicySet {
        let parse = |id: &str, text: &str| {
            Policy::parse(Some(PolicyId::new(id)), text).expect("the seeded policy parses")
        };
        let kept = |skip: &'static str| {
            policies()
                .policies()
                .filter(move |p| p.id().to_string() != skip)
                .cloned()
        };
        let seeded = match self {
            Self::Overflow => {
                let amount = &policy_texts()["amount"];
                let rewritten = amount.replace(
                    "context.total_minor <= resource.max_total_minor",
                    "context.total_minor + 1 <= resource.max_total_minor + 1",
                );
                assert_ne!(
                    &rewritten, amount,
                    "the amount forbid has the expected form"
                );
                parse("amount", &rewritten)
            }
            Self::ExtraPermit => parse("extra_permit", "permit(principal, action, resource);"),
        };
        let skip = match self {
            Self::Overflow => "amount",
            Self::ExtraPermit => "agent",
        };
        PolicySet::from_policies(kept(skip).chain([seeded])).expect("policy ids are unique")
    }
}

/// Cedar's decision for a counterexample or witness from a [`ProofResult`], replayed against
/// `set`: the request and entities are validated against the schema and authorized by
/// `cedar_policy::Authorizer`. Like Cedar, and unlike the engine's fail-closed evaluator, this
/// skips policies that error.
pub fn replay(request: &Value, set: &PolicySet) -> Result<Decision, PolicyError> {
    fn cedar(e: impl Display) -> PolicyError {
        PolicyError::Cedar(e.to_string())
    }
    let uid = |key: &str| EntityUid::from_json(request[key].clone()).map_err(cedar);
    let (principal, action, resource) = (uid("principal")?, uid("action")?, uid("resource")?);
    let context = Context::from_json_value(request["context"].clone(), Some((schema(), &action)))
        .map_err(cedar)?;
    let request_entities = request["entities"].clone();
    let request =
        Request::new(principal, action, resource, context, Some(schema())).map_err(cedar)?;
    let entities = Entities::from_json_value(request_entities, Some(schema())).map_err(cedar)?;
    Ok(
        match Authorizer::new()
            .is_authorized(&request, set, &entities)
            .decision()
        {
            cedar_policy::Decision::Allow => Decision::Allow,
            cedar_policy::Decision::Deny => Decision::Deny,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(set: &PolicySet) -> Vec<ProofResult> {
        let solver = Cvc5::from_env().expect("cvc5 1.3.1 is on PATH or named by CVC5");
        prove_set(&solver, set).unwrap()
    }

    fn verdict(results: &[ProofResult], check: &str, subject: &str) -> Verdict {
        results
            .iter()
            .find(|r| r.check == check && r.subject == subject)
            .unwrap()
            .verdict
    }

    /// Dropping any `forbid` other than the redundant `agent` one breaks the equivalence, so the
    /// spec pins every rule.
    #[test]
    fn every_field_forbid_is_needed_for_equivalence() {
        for dropped in policies()
            .policies()
            .filter(|p| p.effect() == Effect::Forbid)
        {
            let set = PolicySet::from_policies(
                policies()
                    .policies()
                    .filter(|p| p.id() != dropped.id())
                    .cloned(),
            )
            .unwrap();
            let results = run(&set);
            let expected = if dropped.id().to_string() == "agent" {
                Verdict::Verified
            } else {
                Verdict::Counterexample
            };
            assert_eq!(
                verdict(&results, "equivalent", "checkout/policy_set=spec"),
                expected,
                "{}",
                dropped.id()
            );
        }
    }
}
