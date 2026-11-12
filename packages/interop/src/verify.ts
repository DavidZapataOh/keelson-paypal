import { receiptKeyMap } from "@keelson/log";
import { type AcpExport, verifyAcp } from "./acp.ts";
import { type Ap2Export, verifyAp2 } from "./ap2.ts";
import type { StatementFacts } from "./facts.ts";
import { jwtPayload } from "./jose.ts";
import type { EcPublicJwk } from "./signer.ts";
import { type AlibiRef, StatementError, verifyStatement } from "./statement.ts";
import { type TapExport, verifyTap } from "./tap.ts";
import { EXPORT_ISSUER_KEYS } from "./trust.ts";
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
      return [...jwt(v.l1), ...jwt(v.l2)];
    }
    case "keelson.tap/1":
      return [];
    default:
      return jwt(x.attestation);
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Verifies any Keelson export offline: the standard's own signatures and bindings under the issuer
 * keys, the purchase's Transparent Statement and its receipt under the log receipt keys, and every
 * fact the issuer signed against the statement's. The keys default to the pinned ones.
 */
export async function verifyExport(
  artifact: unknown,
  opts: { now: number; issuerKeys?: EcPublicJwk[]; receiptKeys?: ReadonlyMap<string, Uint8Array> },
): Promise<ExportReport> {
  const started = performance.now();
  const o = {
    now: opts.now,
    issuerKeys: opts.issuerKeys ?? EXPORT_ISSUER_KEYS,
    receiptKeys: opts.receiptKeys ?? receiptKeyMap(),
  };
  const x = artifact as Artifact;
  let base: ExportReport;
  switch (x?.type) {
    case "keelson.ap2/1":
      base = await verifyAp2(x as unknown as Ap2Export, o);
      break;
    case "keelson.vi/1":
      base = await verifyVi(x as unknown as ViExport, o);
      break;
    case "keelson.ucp/1":
      base = await verifyUcp(x as unknown as UcpExport, o);
      break;
    case "keelson.acp/1":
      base = await verifyAcp(x as unknown as AcpExport, o);
      break;
    case "keelson.tap/1":
      base = await verifyTap(x as unknown as TapExport, o);
      break;
    case "keelson.visa-evidence-pack/1":
      base = await verifyEvidencePack(x as unknown as EvidencePack, o);
      break;
    default:
      throw new RangeError("not a Keelson export");
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
  const signed = issuerSigned(x).map(
    (j) => jwtPayload(j).keelson as { facts?: unknown; statement?: unknown } | undefined,
  );
  const formatFacts = base.checks.find((c) => c.id === "facts");
  checks.push({
    id: "facts",
    ok:
      facts !== undefined &&
      (formatFacts?.ok ?? true) &&
      signed.every((k) => same(k?.facts, facts) && k?.statement === x.alibi.statement),
  });
  return {
    format: base.format,
    ok: checks.every((c) => c.ok),
    checks,
    ms: performance.now() - started,
  };
}
