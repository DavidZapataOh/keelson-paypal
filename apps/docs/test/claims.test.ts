import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { REPO } from "./lib/markdown";

const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const spec = read("apps/docs/src/content/docs/reference/spec.mdoc");
const threats = read("apps/docs/src/content/docs/security/threat-model.mdoc");

/** The job ids of a GitHub Actions workflow. */
const jobs = (workflow: string) =>
  [...(read(workflow).split(/^jobs:$/m)[1] ?? "").matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]);

describe("the specification's claims hold in code", () => {
  test("Witnesses: 2 of 3 Keelson-run witnesses cosign, on three providers", () => {
    expect(spec).toContain("2 of 3 Keelson-run witnesses on three providers");
    for (const policy of ["alibi-2026-1", "alibi-live-2026-1"]) {
      const p = read(`services/log/policy/${policy}.policy`);
      expect(p.match(/^witness w\d /gm), policy).toHaveLength(3);
      expect(p, policy).toMatch(/^group own 2 w1 w2 w3$/m);
      expect(p, policy).toMatch(/^quorum own$/m);
    }
    expect(read("render.yaml")).toContain("- witness-1.keelson.finance");
    expect(read("services/witness/.railway/railway.ts")).toContain(
      'domain: "witness-2.keelson.finance"',
    );
    expect(read("services/witness/aws/keelson-witness-3.service")).toContain(
      "WITNESS_NAME=witness-3.keelson.finance",
    );
  });

  test("External record: hourly Sigsum co-logging under a 2-of-3 Glasklar, Mullvad and Tillitis quorum", () => {
    expect(spec).toContain(
      "co-logged hourly in Sigsum's seasalp log, cosigned by at least two of the Glasklar, Mullvad and Tillitis witnesses",
    );
    const p = read("services/log/policy/sigsum-seasalp.policy");
    expect(p).toMatch(/^log \w+ https:\/\/seasalp\.glasklar\.is$/m);
    expect(p).toMatch(
      /^group quorum-rule 2 witness\.glasklar\.is witness\.mullvad\.net tillitis\.se\/tillitis-witness-1$/m,
    );
    expect(read("services/log/sigsum.go")).toMatch(/sigsumCadence = time\.Hour\b/);
  });

  test("Log signatures: Ed25519 from the dstack KMS inside leg A, and ML-DSA-44", () => {
    expect(spec).toContain("Ed25519 and ML-DSA-44 on every checkpoint");
    expect(read("services/log/config.go")).toContain("mldsa.NewPrivateKey(mldsa.MLDSA44(), seed)");
    expect(read("engine/tee/src/logsign.rs")).toContain(
      "`GetKey(keelson/log/<origin>/v1, ed25519)`",
    );
    expect(read("engine/tee/src/main.rs")).toContain("keys.push(dstack.log_key(origin).await");
  });

  test("Countersign: each leg's secp256k1 key is generated in RAM at boot; leg B has no KMS root", () => {
    expect(spec).toContain("with a secp256k1 key generated in RAM at boot");
    expect(spec).toContain("an AWS Nitro Enclave with no network and no KMS root");
    expect(read("engine/tee/src/signer.rs")).toContain("key: Box::new(SigningKey::generate()),");
    expect(read("engine/tee/src/engine.rs")).toContain("signer: Signer::generate(),");
    expect(read("engine/tee/src/nitro.rs")).toMatch(
      /tee_kind: TeeKind::Nitro,[\s\S]{0,120}?\},\s*None,\s*\)/,
    );
    expect(read("engine/tee/src/main.rs")).toContain("It has no network and reads no environment");
  });

  test("Budget: max − captured − live reservations, captured from leg A's PayPal read", () => {
    expect(spec).toContain("`max − captured − live reservations`");
    expect(read("engine/tee/src/budget.rs")).toContain(
      "max.saturating_sub(captured_minor).saturating_sub(reserved)",
    );
    expect(read("engine/tee/src/engine.rs")).toContain(
      "/// The amount captured against each mandate, as the engine's own PayPal read reports it.",
    );
  });

  test("PayPal: final_capture, per-cart holds for several merchants, the void at the end", () => {
    expect(spec).toContain(
      "`final_capture` MUST be true only for the capture that uses up the hold",
    );
    expect(read("services/api/src/pipeline/capture-step.ts")).toContain(
      "const finalCapture = perPurchase || amount.minor === m.remainingMinor;",
    );
    expect(read("services/api/src/routes/mandates.ts")).toContain(
      'const holdMode = rail === "paypal" && merchants.allowed.length > 1 ? "per_purchase" : "mandate";',
    );
    const maintenance = read("services/api/src/hold/maintenance.ts");
    for (const end of ["EXPIRED", "EXHAUSTED", "REVOKED"]) {
      expect(maintenance, end).toContain(`voidHold(deps, id, "${end}", now)`);
    }
    expect(maintenance).toContain("const HONOR_PERIOD_MS = 3 * DAY_MS;");
  });

  test("Compilation: two drafting models, a merge never wider than either, gray disagreements, a third checker", () => {
    expect(spec).toContain("Two models draft it independently.");
    const compile = read("packages/compiler/src/compile.ts");
    expect(compile).toMatch(
      /const MODELS = \{\s*opus: "[^"]+",\s*sonnet: "[^"]+",\s*haiku: "[^"]+",\s*\}/,
    );
    expect(compile).toContain('draft(client, "opus", OPUS_SYSTEM');
    expect(compile).toContain('draft(client, "sonnet", SONNET_SYSTEM');
    expect(compile).toContain("model: MODELS.haiku");
    expect(read("packages/compiler/src/diff.ts")).toContain(
      "Merges the drafts of two independent compilations into one that is never wider than either.",
    );
    expect(read("packages/mandate/src/colors.ts")).toContain(
      'for (const f of evidence.ambiguous ?? []) if (colors[f]) colors[f] = "gray";',
    );
  });

  test("Evidence: salted RFC 6962 leaves under evidenceRoot, PII-free public items, hidden text", () => {
    expect(spec).toContain("salted leaf (`keelson/evidence-item/v1`) of an RFC 6962 Merkle tree");
    expect(read("packages/evidence/src/items.ts")).toContain(
      '`SHA-256(0x00 ‖ "keelson/evidence-item/v1" ‖ salt[32]',
    );
    const manifest = read("packages/evidence/src/manifest.ts");
    expect(manifest).toContain("RFC 6962 §2.1 Merkle Tree Hash");
    expect(manifest).toContain("its `evidenceRoot` over the sealed items");
    expect(read("services/api/src/routes/evidence.ts")).toContain(
      '!i.type.endsWith(".original") && containsPii(i.mediaType, i.bytes)',
    );
    expect(read("packages/evidence/src/hidden.ts")).toContain("export function detectHiddenText(");
  });

  test("Mandate: with `embed`, the assertion must name that top-level origin", () => {
    expect(spec).toContain(
      "When `embed` is present, the assertion MUST name that top-level origin.",
    );
    expect(read("engine/tee/src/engine.rs")).toContain("(EMBED_ORIGIN, Some(top.to_owned()))");
    expect(read("packages/alibi/src/verify/checks/mandate.ts")).toContain("data.topOrigin === top");
  });

  test("Policy: symcc proves the set states spec.cedar; the bundle is fresh in CI, attested on main, and pinned by policy-parity", () => {
    expect(spec).toContain(
      "`cedar-policy-symcc` proves that the policy set states the rules in `engine/policy/policy/spec.cedar`",
    );
    expect(read("engine/policy/src/prove.rs")).toContain(
      'pub const SPEC_SRC: &str = include_str!("../policy/spec.cedar");',
    );
    const bundle = JSON.parse(read("engine/policy/proofs/proof-bundle.json"));
    expect(bundle.results.some((r: { check: string }) => r.check === "equivalent")).toBe(true);
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain(
      "cargo run -p keelson-policy --bin prove -- --out engine/policy/proofs/proof-bundle.json\n          git diff --exit-code engine/policy/proofs",
    );
    expect(ci).toMatch(
      /attest-build-provenance@[0-9a-f]{40} # v\d+\.\d+\.\d+\s+with:\s+subject-path: \|\s+engine\/policy\/proofs\/proof-bundle\.json/,
    );
    expect(jobs(".github/workflows/ci.yml")).toEqual(
      expect.arrayContaining(["proofs", "attest-proofs", "policy-parity"]),
    );
    expect(jobs(".github/workflows/nightly.yml")).toContain("policy-parity");
    expect(read("packages/policy/test/parity.test.ts")).toContain("emits byte-identical traces");
  });

  test("Disputes: symcc proves attribution total, exclusive and reachable", () => {
    expect(spec).toContain("with symcc proofs that it is total, exclusive and reachable");
    const bundle = JSON.parse(read("engine/policy/proofs/attribution-bundle.json"));
    const checks = new Set(bundle.results.map((r: { check: string }) => r.check));
    for (const c of ["total", "exclusive", "reachable"]) expect(checks.has(c), c).toBe(true);
  });

  test("Transparency log: the leaf holds exactly the fields the specification lists, and a stop leaf", () => {
    const sentence =
      spec.match(/The object MUST hold hashes and ids only: (.+?)\. A user's/)?.[1] ?? "";
    const listed = [...sentence.matchAll(/`(\w+)`/g)].map((m) => m[1]).sort();
    const leaf = read("packages/log/src/leaf.ts");
    const body = leaf.split("const body = {")[1]?.split("\n  };")[0] ?? "";
    const coded = [...body.matchAll(/(?:^\s+|\{ )([a-z_]+): /gm)].map((m) => m[1]).sort();
    expect(listed.length).toBeGreaterThan(10);
    expect(coded).toEqual(listed);
    expect(spec).toContain("`keelson.finance/stop/v1` leaf");
    expect(leaf).toContain('export const STOP_PREFIX = "keelson.finance/stop/v1\\n";');
    expect(read("services/log/anchor.go")).toMatch(
      /anchorEvery\s+= time\.Hour\s+anchorLeaves = 1000/,
    );
  });

  test("Agents and risk: MCP on Streamable HTTP at /mcp, the OAuth grants, the grade endpoint", () => {
    expect(spec).toContain("`https://api.keelson.finance/mcp`, Streamable HTTP");
    expect(read("services/api/src/mcp.ts")).toContain(
      "Keelson's MCP server on Streamable HTTP at `/mcp`",
    );
    const auth = read("services/api/src/auth.ts");
    expect(auth).toContain(
      'grantTypes: ["client_credentials", "authorization_code", "refresh_token"],',
    );
    expect(auth).toContain("authorization code grant and PKCE (S256 only");
    expect(spec).toContain("`GET /v1/operators/{agentId}/grade`");
    expect(read("services/api/src/routes/grades.ts")).toContain(
      'path: "/v1/operators/{agentId}/grade",',
    );
    expect(read("openapi/keelson.yaml")).toContain("  /v1/operators/{agentId}/grade:\n    get:");
  });

  test("Attestation and veto windows: 72-hour signer TTL and degraded window", () => {
    expect(spec).toContain("only for 72 hours (`SIGNER_TTL`");
    expect(read("contracts/src/VerdictVerifier.sol")).toContain(
      "uint40 public constant SIGNER_TTL = 72 hours;",
    );
    expect(spec).toContain("(`DEGRADED_WINDOW`, 72 hours,");
    expect(read("contracts/src/KeelsonBondVault.sol")).toContain(
      "uint40 public constant DEGRADED_WINDOW = 72 hours;",
    );
  });
});

describe("the card rail holds in code", () => {
  test("a card mandate holds the user's budget on Keelson's PayPal account", () => {
    expect(read("apps/docs/src/content/docs/reference/spec.mdoc")).toContain(
      "holds the user's budget on PayPal, on Keelson's account, which pays the card network",
    );
    expect(read("services/api/src/hold/state.ts")).toContain(
      "A card mandate holds the user's budget on Keelson's account, which pays the card network.",
    );
  });
});

describe("the environments page's claims hold in code", () => {
  test("Harbor Street Coffee is the card issuer sandbox's test merchant, not a real store", () => {
    expect(read("apps/docs/src/content/docs/security/environments.mdoc")).toContain(
      "Harbor Street Coffee is a test merchant on the card issuer's sandbox",
    );
    expect(read("services/api/scripts/card-demo.ts")).toContain(
      "Harbor Street Coffee (test merchant)",
    );
  });
});

describe("the threat model's claims hold in code", () => {
  test("One TEE leg: leg B signs over leg A's observation, and the PayPal hold caps the capture", () => {
    expect(threats).toContain("Lie in the observation leg B signs over");
    expect(threats).toContain("capture more than the PayPal hold the user approved");
    expect(read("engine/tee/src/engine.rs")).toContain(
      ".or(r.observation.as_ref().map(|o| &o.paypal));",
    );
    expect(read("services/api/src/hold/state.ts")).toContain("minor: row.maxMinor");
    expect(read("services/api/src/pipeline/capture-step.ts")).toContain(
      'if (amount.minor > m.remainingMinor) return await refuse("capture:budget-exceeded");',
    );
  });

  test("Relayer key: publishes registered-user roots, which the Guardian can revoke", () => {
    expect(threats).toContain("publish a registered-user root");
    expect(threats).toContain("the Guardian can revoke one");
    expect(read("contracts/src/RegisteredUserSet.sol")).toMatch(
      /`publish` is restricted by the\s*\/\/\/ AccessManager to `PUBLISHER_ROLE`, held by Keelson's relayer, and `revoke` to `GUARDIAN_ROLE`/,
    );
    const deploy = read("contracts/script/DeployRegisteredUserSet.s.sol");
    expect(deploy).toContain("(predict(NAME), revoke, KeelsonRoles.GUARDIAN_ROLE)");
    expect(deploy).toContain("(KeelsonRoles.PUBLISHER_ROLE, relayer(), 0)");
  });
});

describe("the docs claim nothing upstream that is not there", () => {
  // Nothing of this extension is open upstream; the pages describe the toolkit gap only.
  test("no page points at a pull request or an issue thread in PayPal's Agent Toolkit", () => {
    for (const path of [
      "README.md",
      "docs/paypal-agent-mandate-extension.md",
      "apps/docs/src/content/docs/reference/ks1.mdoc",
    ]) {
      expect(read(path), path).not.toMatch(/agent-toolkit\/(pull|issues)\/\d+/);
    }
  });
});
