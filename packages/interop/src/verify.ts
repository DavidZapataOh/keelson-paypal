import { receiptKeyMap } from "@keelson/log";
import { base64url } from "jose";
import { type AcpExport, verifyAcp } from "./acp.ts";
import { type Ap2Export, verifyAp2 } from "./ap2.ts";
import type { StatementFacts } from "./facts.ts";
import { jwtPayload } from "./jose.ts";
import type { EcPublicJwk } from "./signer.ts";
import { type AlibiRef, StatementError, verifyStatement } from "./statement.ts";
import { type TapExport, verifyTap } from "./tap.ts";
import { AGENT_HTTP_KEYS, EXPORT_ISSUER_KEYS } from "./trust.ts";
import { type UcpExport, verifyUcp } from "./ucp.ts";
import { type ViExport, verifyVi } from "./vi.ts";
import { type EvidencePack, verifyEvidencePack } from "./visa.ts";

/** The formats Keelson exports to. */
export type Format = "ap2" | "vi" | "ucp" | "acp" | "tap" | "visa";

/** One check of an export's verification. */
export type CheckId =
  | "schema"
  | "signatures"
  | "issuer"
  | "statement"
  | "receipt"
  | "facts"
  | "chain_binding"
  | "nonce"
  | "receipt_reference"
  | "bundle"
  | "passkey"
  | "window"
  | "tag"
  | "replay";

/** What verifying an export found. */
export interface ExportReport {
  format: Format;
  ok: boolean;
  checks: { id: CheckId; ok: boolean; detail?: string }[];
  ms: number;
}

type Artifact = { type: string; alibi: AlibiRef } & Record<string, unknown>;

/** The issuer-signed JWSs an export carries, whose `keelson.facts` must be the statement's. */
function issuerSigned(x: Artifact): string[] {
  const jwt = (s: unknown) => (typeof s === "string" ? [s.split("~")[0] as string] : []);
  switch (x.type) {
    case "keelson.ap2/1": {
      const a = x as unknown as Ap2Export;
      return [
        ...jwt(a.checkout.open),
        ...jwt(a.payment.open),
        ...jwt(a.checkout.checkout_jwt),
        ...jwt(a.checkout.receipt),
        ...jwt(a.payment.receipt),
      ];
    }
    case "keelson.vi/1": {
      const v = x as unknown as ViExport;
      return [...jwt(v.l1), ...jwt(v.l2), ...jwt(viCheckoutJwt(v))];
    }
    case "keelson.tap/1":
      return [];
    default:
      return jwt(x.attestation);
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const FORMAT_OF: Record<string, Format> = {
  "keelson.ap2/1": "ap2",
  "keelson.vi/1": "vi",
  "keelson.ucp/1": "ucp",
  "keelson.acp/1": "acp",
  "keelson.tap/1": "tap",
  "keelson.visa-evidence-pack/1": "visa",
};

/** The checkout JWT of a VI export, from its closed L3b or its pending checkout mandate. */
function viCheckoutJwt(v: ViExport): string | undefined {
  const pending = v.pending_close?.checkout as { checkout_jwt?: string } | undefined;
  if (pending?.checkout_jwt) return pending.checkout_jwt;
  if (!v.l3_checkout) return undefined;
  for (const d of v.l3_checkout.split("~").slice(1)) {
    if (!d) continue;
    try {
      const value = JSON.parse(new TextDecoder().decode(base64url.decode(d))) as unknown[];
      const jwt = (value.at(-1) as { checkout_jwt?: unknown })?.checkout_jwt;
      if (typeof jwt === "string") return jwt;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The format's own verification of an export. */
async function formatReport(
  x: Artifact,
  o: {
    now: number;
    issuerKeys: EcPublicJwk[];
    receiptKeys: ReadonlyMap<string, Uint8Array>;
    agentKeys: object[];
  },
): Promise<ExportReport> {
  switch (x.type) {
    case "keelson.ap2/1":
      return verifyAp2(x as unknown as Ap2Export, o);
    case "keelson.vi/1":
      return verifyVi(x as unknown as ViExport, o);
    case "keelson.ucp/1":
      return verifyUcp(x as unknown as UcpExport, o);
    case "keelson.acp/1":
      return verifyAcp(x as unknown as AcpExport, o);
    case "keelson.tap/1":
      return verifyTap(x as unknown as TapExport, o);
    default:
      return verifyEvidencePack(x as unknown as EvidencePack, o);
  }
}

/**
 * Verifies any Keelson export offline: the standard's own signatures and bindings under the issuer
 * keys, the purchase's Transparent Statement and its receipt under the log receipt keys, and every
 * fact the issuer signed against the statement's. The keys default to the pinned ones.
 */
export async function verifyExport(
  artifact: unknown,
  opts: {
    now: number;
    issuerKeys?: EcPublicJwk[];
    receiptKeys?: ReadonlyMap<string, Uint8Array>;
    agentKeys?: object[];
  },
): Promise<ExportReport> {
  const started = performance.now();
  const o = {
    now: opts.now,
    issuerKeys: opts.issuerKeys ?? EXPORT_ISSUER_KEYS,
    receiptKeys: opts.receiptKeys ?? receiptKeyMap(),
    agentKeys: opts.agentKeys ?? AGENT_HTTP_KEYS,
  };
  const x = artifact as Artifact;
  if (!FORMAT_OF[x?.type as string]) throw new RangeError("not a Keelson export");
  let base: ExportReport;
  try {
    base = await formatReport(x, o);
  } catch (e) {
    // A malformed export fails its own checks rather than the verifier.
    base = {
      format: FORMAT_OF[x.type] as Format,
      ok: false,
      checks: [{ id: "signatures", ok: false, detail: (e as Error).message }],
      ms: 0,
    };
  }
  const checks = base.checks.filter((c) => c.id !== "facts");
  let facts: StatementFacts | undefined;
  try {
    facts = verifyStatement(x.alibi, o);
    checks.push({ id: "statement", ok: true }, { id: "receipt", ok: true });
  } catch (e) {
    // A statement that does not verify leaves its receipt unchecked: both fail.
    const receiptOnly = e instanceof StatementError && e.code === "receipt";
    checks.push({ id: "statement", ok: receiptOnly }, { id: "receipt", ok: false });
  }
  let signed: ({ facts?: unknown; statement?: unknown } | undefined)[] | undefined;
  try {
    signed = issuerSigned(x).map(
      (j) => jwtPayload(j).keelson as { facts?: unknown; statement?: unknown } | undefined,
    );
  } catch {
    signed = undefined;
  }
  const formatFacts = base.checks.find((c) => c.id === "facts");
  checks.push({
    id: "facts",
    ok:
      facts !== undefined &&
      signed !== undefined &&
      (formatFacts?.ok ?? true) &&
      // A payer request stands for a payment: only an allowed purchase has one.
      (x.type !== "keelson.tap/1" || facts.decision === "allow") &&
      signed.every((k) => same(k?.facts, facts) && k?.statement === x.alibi.statement),
  });
  return {
    format: base.format,
    ok: checks.every((c) => c.ok),
    checks,
    ms: performance.now() - started,
  };
}
