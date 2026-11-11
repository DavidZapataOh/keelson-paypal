import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base64url } from "jose";
import { keelsonClaim } from "./ap2.ts";
import { transform } from "./bindings.ts";
import { type PurchaseFacts, type StatementFacts, statementFacts } from "./facts.ts";
import { issuedBy, jwtPayload } from "./jose.ts";
import { type EcPublicJwk, ExportRefused, type ExportSigner } from "./signer.ts";
import type { AlibiRef } from "./statement.ts";
import type { CheckId, ExportReport } from "./verify.ts";

/** ACP lets an allowance live briefly; Keelson's lives at most 15 minutes past the countersign. */
export const ACP_MAX_TTL_SECONDS = 900;
/** The export profile of the issuer's attestation over an ACP allowance. */
export const ACP_ALLOWANCE = "acp.allowance/1";

/** ACP 2026-04-17 `Allowance` (`schema.delegate_payment.json#/$defs/Allowance`). */
export interface AcpAllowance {
  reason: "one_time";
  max_amount: number;
  currency: string;
  checkout_session_id: string;
  merchant_id: string;
  expires_at: string;
}

/** A purchase as an ACP delegated payment allowance, with the statement it rests on. */
export interface AcpExport {
  type: "keelson.acp/1";
  version: "2026-04-17";
  alibi: AlibiRef;
  allowance: AcpAllowance;
  /** ACP `metadata`: strings only. */
  metadata: {
    keelson_alibi_uri: string;
    keelson_alibi_sha256: string;
    keelson_mandate_hash: string;
  };
  /** The issuer's compact JWS over `{ allowance, metadata, keelson }`. */
  attestation: string;
}

/** The smallest cap the mandate puts on one purchase, in minor units. */
function capOf(f: PurchaseFacts): number {
  const caps = (f.mandate.payment?.constraints ?? [])
    .filter((c) => c?.type === "payment.amount_range" || c?.type === "payment.budget")
    .map((c) => Number((c as { max?: number }).max))
    .filter((n) => Number.isSafeInteger(n));
  return caps.length ? Math.min(...caps) : f.totalMinor;
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/**
 * The allowance a purchase ran under: `max_amount` is the mandate's tightest cap, `expires_at`
 * the earlier of the mandate's expiry and 15 minutes after the countersign.
 */
export async function exportAcp(
  f: PurchaseFacts,
  ref: AlibiRef,
  k: { issuer: ExportSigner },
  _o: { now: number },
): Promise<AcpExport> {
  if (f.decision !== "allow") throw new ExportRefused("denied");
  const facts = statementFacts(f);
  const allowance: AcpAllowance = {
    reason: "one_time",
    max_amount: capOf(f),
    currency: transform("LowerCurrency", facts.currency, facts) as string,
    checkout_session_id: f.orderId ?? f.alibiId,
    merchant_id: f.payee,
    expires_at: iso(
      Math.min(f.mandate.exp ?? Number.POSITIVE_INFINITY, f.issuedAt + ACP_MAX_TTL_SECONDS),
    ),
  };
  const metadata = {
    keelson_alibi_uri: ref.uri,
    keelson_alibi_sha256: bytesToHex(sha256(base64url.decode(ref.statement))),
    keelson_mandate_hash: f.mandateHash,
  };
  const attestation = await k.issuer.sign(
    "JWT",
    { allowance, metadata, keelson: keelsonClaim(f, ref, ACP_ALLOWANCE) },
    ref.statement,
  );
  return {
    type: "keelson.acp/1",
    version: "2026-04-17",
    alibi: ref,
    allowance,
    metadata,
    attestation,
  };
}

/** Verifies an ACP export offline against its issuer and the statement facts it is bound to. */
export async function verifyAcp(
  x: AcpExport,
  o: { now: number; issuerKeys: EcPublicJwk[] },
): Promise<ExportReport> {
  const started = performance.now();
  const p = jwtPayload(x.attestation) as {
    allowance?: AcpAllowance;
    metadata?: AcpExport["metadata"];
    keelson?: { statement?: string; facts?: StatementFacts };
  };
  const facts = p.keelson?.facts;
  const checks: { id: CheckId; ok: boolean }[] = [
    { id: "issuer", ok: await issuedBy(x.attestation, o.issuerKeys) },
    {
      id: "signatures",
      ok:
        JSON.stringify(p.allowance) === JSON.stringify(x.allowance) &&
        JSON.stringify(p.metadata) === JSON.stringify(x.metadata) &&
        p.keelson?.statement === x.alibi.statement,
    },
    {
      id: "facts",
      ok:
        facts !== undefined &&
        x.allowance.max_amount >= facts.amount_minor &&
        x.allowance.currency === transform("LowerCurrency", facts.currency, facts) &&
        x.metadata.keelson_alibi_sha256 ===
          bytesToHex(sha256(base64url.decode(x.alibi.statement))) &&
        x.metadata.keelson_mandate_hash === facts.mandate_hash,
    },
  ];
  return { format: "acp", ok: checks.every((c) => c.ok), checks, ms: performance.now() - started };
}
