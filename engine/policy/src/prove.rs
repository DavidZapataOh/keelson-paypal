use std::path::PathBuf;
use std::str::FromStr;
use std::time::{Duration, Instant};
use std::{env, io};

use cedar_policy::{Effect, EntityUid, PolicySet};
use cedar_policy_symcc::err::Error;
use cedar_policy_symcc::solver::{LocalSolver, SolverError};
use cedar_policy_symcc::{CedarSymCompiler, CompiledPolicy, CompiledPolicySet, Env};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::extras::{Extra, compile};
use crate::hashes::hex;
use crate::{policies, policy_set_hash_tag, schema, schema_hash_tag};

/// The reference spec source, `policy/spec.cedar`: one `permit` stating every mandate rule.
pub const SPEC_SRC: &str = include_str!("../policy/spec.cedar");
/// The `cedar-policy-symcc` version the proofs run on.
pub const SYMCC_VERSION: &str = "0.8.1";
/// The cvc5 release `cedar-policy-symcc` [`SYMCC_VERSION`] is built and verified against.
pub const CVC5_VERSION: &str = "1.3.1";
const CEDAR_POLICY_VERSION: &str = "4.14.1";

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
        let path = env::var_os("CVC5").map_or_else(|| PathBuf::from("cvc5"), PathBuf::from);
        let out = std::process::Command::new(&path)
            .arg("--version")
            .output()
            .map_err(|e| io::Error::new(e.kind(), format!("{}: {e}", path.display())))?;
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

/// Runs every check on the policy set, over every request environment of the schema:
///
/// - `equivalent`: the policy set and the spec decide every request the same way;
/// - `never_errors`: each `forbid`, and a policy of each [`Extra`] kind, never errors;
/// - `satisfiable`: some request is allowed (the policy set does not always deny);
/// - `not_always_allows`: some request is denied.
///
/// The last two keep the equivalence from holding vacuously.
pub fn prove_all(solver: &Cvc5) -> Result<ProofBundle, Box<Error>> {
    let spec = PolicySet::from_str(SPEC_SRC).expect("the bundled spec parses");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| Error::from(SolverError::from(e)))?;
    let results = runtime.block_on(check(solver, policies(), &spec))?;
    Ok(ProofBundle {
        symcc: SYMCC_VERSION.to_owned(),
        cvc5: solver.version().to_owned(),
        cedar_policy: CEDAR_POLICY_VERSION.to_owned(),
        policy_set_hash: policy_set_hash_tag(),
        schema_hash: schema_hash_tag(),
        spec_hash: spec_hash_tag(),
        results,
    })
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

async fn check(
    solver: &Cvc5,
    set: &PolicySet,
    spec: &PolicySet,
) -> Result<Vec<ProofResult>, Box<Error>> {
    let schema = schema();
    let (names, kinds): (Vec<_>, Vec<_>) = extra_kinds().into_iter().unzip();
    let extras = compile(&kinds).expect("each extra kind compiles");
    let mut symcc = CedarSymCompiler::new(solver.spawn().map_err(Error::from)?)?;
    let mut results = Vec::new();
    for env in schema.request_envs() {
        let t = Instant::now();
        let compiled = CompiledPolicySet::compile(set, &env, schema)?;
        let compiled_spec = CompiledPolicySet::compile(spec, &env, schema)?;
        let cex = symcc
            .check_equivalent_with_counterexample_opt(&compiled, &compiled_spec)
            .await?;
        results.push(result("equivalent", "policy_set=spec", cex, t));

        let forbids = set
            .policies()
            .filter(|p| p.effect() == Effect::Forbid)
            .map(|p| (p.id().to_string(), p));
        let extras = names
            .iter()
            .zip(&extras)
            .map(|(name, (_, p, _))| ((*name).to_owned(), p));
        for (subject, policy) in forbids.chain(extras) {
            let t = Instant::now();
            let compiled = CompiledPolicy::compile(policy, &env, schema)?;
            let cex = symcc
                .check_never_errors_with_counterexample_opt(&compiled)
                .await?;
            results.push(result("never_errors", &subject, cex, t));
        }

        let t = Instant::now();
        let holds = !symcc.check_always_denies_opt(&compiled).await?;
        results.push(holds_result("satisfiable", "policy_set", holds, t));

        let t = Instant::now();
        let holds = !symcc.check_always_allows_opt(&compiled).await?;
        results.push(holds_result("not_always_allows", "policy_set", holds, t));
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
        elapsed,
    }
}

fn holds_result(check: &str, subject: &str, holds: bool, started: Instant) -> ProofResult {
    ProofResult {
        check: check.to_owned(),
        subject: subject.to_owned(),
        verdict: if holds {
            Verdict::Verified
        } else {
            Verdict::Counterexample
        },
        counterexample: None,
        elapsed: started.elapsed(),
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

#[cfg(test)]
mod tests {
    use cedar_policy::{Policy, PolicyId};

    use super::*;

    fn run(set: &PolicySet) -> Vec<ProofResult> {
        let solver = Cvc5::from_env().expect("cvc5 1.3.1 is on PATH or named by CVC5");
        let spec = PolicySet::from_str(SPEC_SRC).unwrap();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(check(&solver, set, &spec))
            .unwrap()
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
                verdict(&results, "equivalent", "policy_set=spec"),
                expected,
                "{}",
                dropped.id()
            );
        }
    }

    #[test]
    fn a_forbid_that_can_overflow_has_a_counterexample() {
        let overflow = Policy::parse(
            Some(PolicyId::new("overflow")),
            r#"forbid(principal, action == Keelson::Action::"checkout", resource) unless { context.total_minor + 1 <= resource.max_total_minor };"#,
        )
        .unwrap();
        let mut set = policies().clone();
        set.add(overflow).unwrap();
        let results = run(&set);
        let r = results
            .iter()
            .find(|r| r.check == "never_errors" && r.subject == "overflow")
            .unwrap();
        assert_eq!(r.verdict, Verdict::Counterexample);
        let cex = r.counterexample.as_ref().unwrap();
        assert!(cex["context"]["total_minor"].is_i64(), "{cex}");
        assert!(cex["entities"].is_array(), "{cex}");
    }
}
