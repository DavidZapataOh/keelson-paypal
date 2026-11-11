import { keelsonClaim } from "./ap2.ts";
import { holds, transform } from "./bindings.ts";
import { type PurchaseFacts, type StatementFacts, statementFacts } from "./facts.ts";
import { issuedBy, jwtPayload } from "./jose.ts";
import type { EcPublicJwk, ExportSigner } from "./signer.ts";
import type { AlibiRef } from "./statement.ts";
import type { CheckId, ExportReport } from "./verify.ts";

/**
 * The Agentic Evidence Pack: what an Alibi proves about one purchase, mapped to the Visa Core
 * Rules' Agentic Platform Requirements (§4.1.23) and to Compelling Evidence 3.0 for Dispute
 * Condition 10.4 (§11.8.5.3, Table 11-29), each claim pointing at the signed value that proves it.
 */
export const PACK_TYPE = "keelson.visa-evidence-pack/1";
export const RULES_EDITION = "Visa Core Rules and Visa Product and Service Rules, 24 October 2026";
/** The export profile of the issuer's attestation over a pack. */
export const VISA_PACK = "visa.pack/1";

/** §4.1.23.8: an order confirmation stays available for at least 120 days. */
const RETENTION_DAYS = 120;
/** Table 11-29: a device fingerprint counts from 20 characters. */
const MIN_FINGERPRINT = 20;
const DAY_MS = 86_400_000;

export type ItemStatus = "evidenced" | "not_evidenced" | "withheld" | "not_available";

/** A value the pack relies on: where it is signed, and what it is. */
export interface EvidenceRef {
  /** `statement`: the countersigned facts; `mandate`: the passkey-signed mandate as disclosed; `bundle`: the Alibi. */
  source: "statement" | "mandate" | "bundle";
  /** RFC 6901. */
  pointer: string;
  value: unknown;
}

export interface PackItem {
  rule: string;
  title: string;
  status: ItemStatus;
  statement: string;
  evidence: EvidenceRef[];
}

export interface EvidencePack {
  type: typeof PACK_TYPE;
  rules: typeof RULES_EDITION;
  generated_at: string;
  retained_until: string;
  transaction: {
    alibi_id: string;
    decision: "allow" | "deny";
    countersigned_at: string;
    amount_minor: number;
    currency: string;
    merchant: { id: string; name: string; website?: string };
    rail: "paypal" | "card";
    confirmation_id?: string;
  };
  requirements: PackItem[];
  ce3: { dispute_condition: "10.4"; table: "11-29"; elements: PackItem[] };
  transparency: { standards: "RFC 9943, RFC 9942"; statement_uri: string; leaf_hash: string };
  alibi: AlibiRef;
  /** The issuer's compact JWS over `{ pack, keelson }`, `pack` being everything but this member. */
  attestation: string;
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

const at = (source: EvidenceRef["source"], pointer: string, value: unknown): EvidenceRef[] =>
  value === undefined ? [] : [{ source, pointer, value }];

function requirements(f: PurchaseFacts, b: { cart?: unknown }): PackItem[] {
  const c = f.mandate.consent ?? {};
  const s = statementFacts(f);
  const cart = b.cart as
    | { lines?: unknown; return_days?: number; returns_free?: boolean }
    | undefined;
  const all = (...v: unknown[]) => v.every((x) => x !== undefined && x !== false);
  return [
    {
      rule: "4.1.23.3",
      title: "Pre-transaction: consent, expiry and acknowledgement of responsibility",
      status: all(c.instruction_use, c.responsibility_ack, c.terms_hash, f.mandate.exp)
        ? "evidenced"
        : "not_evidenced",
      statement:
        "The cardholder consented to the agent's instruction, acknowledged responsibility and accepted the terms by a passkey signature over the mandate, which expires at the stated time.",
      evidence: [
        ...at("mandate", "/consent/instruction_use", c.instruction_use),
        ...at("mandate", "/consent/responsibility_ack", c.responsibility_ack),
        ...at("mandate", "/consent/terms_hash", c.terms_hash),
        ...at("mandate", "/exp", f.mandate.exp),
        ...at("statement", "/mandate_hash", s.mandate_hash),
      ],
    },
    {
      rule: "4.1.23.4",
      title: "Only the cardholder-defined criteria were used",
      status: "evidenced",
      statement:
        f.decision === "allow"
          ? "Two attested enclaves checked the purchase against every constraint of the mandate and countersigned it."
          : "Two attested enclaves checked the cart against the mandate and refused it; nothing was charged under this cart.",
      evidence: [
        ...at("statement", "/decision", s.decision),
        ...at("statement", "/request_id", s.request_id),
      ],
    },
    {
      rule: "4.1.23.6",
      title: "Merchant policy accepted on the cardholder's behalf",
      status: c.merchant_policy_ack ? "evidenced" : "not_evidenced",
      statement: "The mandate states when the agent may accept the merchant's policies.",
      evidence: at("mandate", "/consent/merchant_policy_ack", c.merchant_policy_ack),
    },
    {
      rule: "4.1.23.8",
      title: "Order confirmation, kept at least 120 days",
      status: f.decision === "allow" && cart ? "evidenced" : "not_evidenced",
      statement: cart
        ? "The goods, total, currency, merchant and return policy are in the Alibi, which Keelson keeps available for at least 120 days."
        : "This Alibi does not disclose its cart, so the goods are not itemized; the total, currency and merchant are countersigned.",
      evidence: [
        ...at("statement", "/amount_minor", s.amount_minor),
        ...at("statement", "/currency", s.currency),
        ...at("bundle", "/cart/lines", cart?.lines),
        ...at("bundle", "/cart/return_days", cart?.return_days),
        ...at("bundle", "/cart/returns_free", cart?.returns_free),
      ],
    },
    {
      rule: "4.1.23.9",
      title: "Repeated transactions",
      status: c.recurrence_ack !== undefined ? "evidenced" : "not_evidenced",
      statement: "The mandate states whether the agent may repeat purchases.",
      evidence: at("mandate", "/consent/recurrence_ack", c.recurrence_ack),
    },
    {
      rule: "4.1.23.10",
      title: "Cardholder responsibility for the agent's actions",
      status: "evidenced",
      statement:
        "The cardholder is responsible for the agent's actions within the instruction. The mandate is the instruction: anything outside it was refused or is attributable from this record.",
      evidence: [
        ...at(
          "bundle",
          "/mandate/user_auth",
          (b as { mandate?: { user_auth?: unknown } }).mandate?.user_auth,
        ),
      ],
    },
  ];
}

function ce3(f: PurchaseFacts, shipping: string | undefined): PackItem[] {
  const personal = f.personal;
  const withheld = (rule: string, title: string): PackItem => ({
    rule,
    title,
    status: "withheld",
    statement: "Personal data is withheld from this copy; the cardholder's copy carries it.",
    evidence: [],
  });
  const fp = personal?.deviceFp;
  return [
    {
      rule: "prior_transactions",
      title: "Two prior undisputed transactions, 120 to 365 days old",
      status: "not_available",
      statement:
        "Keelson's history is younger than 120 days; the issuer's own records may supply them.",
      evidence: [],
    },
    personal
      ? {
          rule: "login_id",
          title: "Account or login ID, including the Agentic Payment Provider's",
          status: personal.appLoginId ? "evidenced" : "not_evidenced",
          statement:
            "The login the cardholder used with the agent platform, signed into the mandate.",
          evidence: at("mandate", "/user/app_login_id", personal.appLoginId),
        }
      : withheld("login_id", "Account or login ID, including the Agentic Payment Provider's"),
    personal
      ? {
          rule: "ip_address",
          title: "IP address",
          status: personal.ip ? "evidenced" : "not_evidenced",
          statement: "The IP address the mandate was signed from.",
          evidence: at("mandate", "/risk_data/ip", personal.ip),
        }
      : withheld("ip_address", "IP address"),
    personal
      ? {
          rule: "device_fingerprint",
          title: "Device fingerprint",
          status: fp && fp.length >= MIN_FINGERPRINT ? "evidenced" : "not_evidenced",
          statement:
            fp && fp.length >= MIN_FINGERPRINT
              ? "The device fingerprint the mandate was signed from."
              : `The device fingerprint has ${fp?.length ?? 0} characters; Compelling Evidence 3.0 counts one from ${MIN_FINGERPRINT}.`,
          evidence: at("mandate", "/risk_data/device_fp", fp),
        }
      : withheld("device_fingerprint", "Device fingerprint"),
    {
      rule: "delivery_address",
      title: "Full delivery address",
      status: shipping ? "evidenced" : "not_available",
      statement: shipping
        ? `Shipped to ${shipping}, as PayPal recorded the order.`
        : "No delivery address was recorded for this purchase.",
      evidence: [],
    },
  ];
}

/**
 * The evidence pack of a purchase, attested by the issuer. `shipping` is the order's delivery
 * address as PayPal recorded it, which only the cardholder's copy carries.
 */
export async function evidencePack(
  f: PurchaseFacts,
  ref: AlibiRef,
  k: { issuer: ExportSigner },
  o: { now: number; bundle: { cart?: unknown; mandate?: unknown }; shipping?: string },
): Promise<EvidencePack> {
  const pack: Omit<EvidencePack, "attestation"> = {
    type: PACK_TYPE,
    rules: RULES_EDITION,
    generated_at: iso(o.now),
    retained_until: new Date(f.issuedAt * 1000 + RETENTION_DAYS * DAY_MS).toISOString(),
    transaction: {
      alibi_id: f.alibiId,
      decision: f.decision,
      countersigned_at: iso(f.issuedAt),
      amount_minor: f.totalMinor,
      currency: f.currency,
      merchant: f.merchant,
      rail: f.rail,
      ...(f.confirmationId ? { confirmation_id: f.confirmationId } : {}),
    },
    requirements: requirements(f, o.bundle),
    ce3: {
      dispute_condition: "10.4",
      table: "11-29",
      elements: ce3(f, f.personal ? o.shipping : undefined),
    },
    transparency: {
      standards: "RFC 9943, RFC 9942",
      statement_uri: ref.uri,
      leaf_hash: ref.leafHash,
    },
    alibi: ref,
  };
  const attestation = await k.issuer.sign(
    "JWT",
    { pack, keelson: keelsonClaim(f, ref, VISA_PACK) },
    ref.statement,
  );
  return { ...pack, attestation };
}

/** Verifies a pack offline: the issuer's attestation over it and its transaction against the statement facts. */
export async function verifyEvidencePack(
  p: EvidencePack,
  o: { now: number; issuerKeys: EcPublicJwk[] },
): Promise<ExportReport> {
  const started = performance.now();
  const { attestation, ...pack } = p;
  const signed = jwtPayload(attestation) as {
    pack?: unknown;
    keelson?: { facts?: StatementFacts; statement?: string };
  };
  const facts = signed.keelson?.facts;
  const checks: { id: CheckId; ok: boolean }[] = [
    { id: "issuer", ok: await issuedBy(attestation, o.issuerKeys) },
    {
      id: "signatures",
      ok:
        JSON.stringify(signed.pack) === JSON.stringify(pack) &&
        signed.keelson?.statement === p.alibi.statement,
    },
    {
      id: "facts",
      ok: holds(
        () =>
          facts !== undefined &&
          p.transaction.amount_minor === Number(facts.amount_minor) &&
          p.transaction.currency === transform("UpperCurrency", facts.currency, facts) &&
          p.transaction.decision === facts.decision,
      ),
    },
  ];
  return { format: "visa", ok: checks.every((c) => c.ok), checks, ms: performance.now() - started };
}
