import { type AlibiBundle, verifyUrl } from "@keelson/alibi";
import type { PurchaseFacts } from "./facts.ts";

/**
 * The Agentic Evidence Pack: what an Alibi proves, mapped to the Visa Core Rules' Agentic
 * Platform Requirements (§4.1.23.1–11, edition of 24 October 2026) and to Compelling Evidence
 * 3.0 for Dispute Condition 10.4. Each item points (RFC 6901) into the Alibi that proves it.
 */

export const PACK_TYPE = "keelson.visa-evidence-pack/1";
const RULES_EDITION = "Visa Core Rules and Visa Product and Service Rules, 24 October 2026";

/** How the Alibi stands on one requirement. */
export type PackStatus = "evidenced" | "not_evidenced" | "withheld" | "informational";

export interface PackItem {
  rule: string;
  title: string;
  status: PackStatus;
  statement: string;
  /** RFC 6901 pointers into the Alibi bundle, and the values read there. */
  evidence: { pointer: string; value: unknown }[];
}

export interface Ce3Element {
  element:
    | "account_login_id"
    | "device_fingerprint"
    | "ip_address"
    | "shipping_address"
    | "prior_transactions";
  status: "provided" | "withheld" | "not_available" | "below_minimum" | "merchant_to_supply";
  value?: string;
  note?: string;
}

export interface EvidencePack {
  type: typeof PACK_TYPE;
  rules: string;
  generated_at: string;
  transaction: {
    alibi_id: string;
    decision: "allow" | "deny";
    countersigned_at: string;
    amount_minor: number;
    currency: string;
    merchant: { id: string; name: string; website?: string };
    paypal?: { order_id: string; capture_id?: string; transaction_id?: string };
  };
  requirements: PackItem[];
  ce3: { dispute_condition: "10.4"; elements: Ce3Element[] };
  order_confirmation: {
    description: string;
    merchant_contact?: string;
    total_minor: number;
    currency: string;
    return_policy: string;
    available_at: string;
    retained_until: string;
  };
  verify_url: string;
}

const DAY = 86_400_000;
/** §4.1.23.8: at least 120 days from the Processing Date. */
const RETENTION_DAYS = 120;
/** CE3.0: a device fingerprint must be at least 20 characters. */
const MIN_FINGERPRINT = 20;

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/**
 * The evidence pack of an Alibi. `shipping` is the PayPal order's shipping address, which the
 * caller reads from PayPal when it may. The user's login id, device and IP are personal: the
 * public copy of an Alibi withholds them, and so does its pack.
 */
export function evidencePack(
  b: AlibiBundle,
  f: PurchaseFacts,
  opts: { now: Date; alibiUrl: string; shipping?: string | undefined },
): EvidencePack {
  const m = f.mandate;
  const consent = m.consent ?? {};
  const exp = m.exp;
  const passkey = b.mandate.user_auth as Record<string, unknown>;
  const allow = f.decision === "allow" && b.tee.countersign.failedFieldsMask === "0";
  const flag = (v: boolean | undefined): PackStatus => (v === true ? "evidenced" : "not_evidenced");
  const at = (pointer: string, value: unknown) => ({ pointer, value });
  const requirements: PackItem[] = [
    {
      rule: "4.1.23.2",
      title: "Visa Intelligent Commerce enrollment",
      status: "not_evidenced",
      statement:
        "Keelson does not claim Visa Intelligent Commerce enrollment; the agent's operator is named in the mandate.",
      evidence: [at("/leaf_view/agent_id", b.leaf_view.agent_id)],
    },
    {
      rule: "4.1.23.3",
      title:
        "Consent to the cardholder-defined instruction, its expiry, responsibility and identity",
      status:
        consent.instruction_use && consent.responsibility_ack && exp !== undefined
          ? "evidenced"
          : "not_evidenced",
      statement: `The cardholder signed the instruction with a passkey (user verification required) after Keelson showed its terms, its expiry (${exp === undefined ? "undisclosed" : iso(exp)}) and that the cardholder is responsible for the agent's actions.`,
      evidence: [
        at("/mandate/payload_sd/consent/instruction_use", consent.instruction_use),
        at("/mandate/payload_sd/consent/responsibility_ack", consent.responsibility_ack),
        at("/mandate/payload_sd/consent/terms_hash", consent.terms_hash),
        at("/mandate/payload_sd/exp", exp),
        at("/mandate/user_auth/authenticatorData", passkey.authenticatorData),
      ],
    },
    {
      rule: "4.1.23.4",
      title: "Use only the cardholder-defined criteria",
      status: allow ? "evidenced" : f.decision === "deny" ? "evidenced" : "not_evidenced",
      statement: allow
        ? "Both TEE legs evaluated the cart against every field of the instruction and countersigned it with no failed field."
        : "Keelson's countersign refused the cart because it fell outside the instruction; no payment was authorized.",
      evidence: [
        at("/tee/countersign/decision", b.tee.countersign.decision),
        at("/tee/countersign/failedFieldsMask", b.tee.countersign.failedFieldsMask),
        at("/tee/mode", b.tee.mode),
      ],
    },
    {
      rule: "4.1.23.5",
      title: "Cardholder verification when the instructions are presented",
      status: passkey.authenticatorData ? "evidenced" : "not_evidenced",
      statement:
        "The cardholder verified with a device passkey (WebAuthn, user verification) over the instruction's digest M.",
      evidence: [at("/leaf_view/mandate_hash", b.leaf_view.mandate_hash)],
    },
    {
      rule: "4.1.23.6",
      title: "Consent to the merchant's policies",
      status: consent.merchant_policy_ack ? "evidenced" : "not_evidenced",
      statement: `The cardholder acknowledged the merchant's policies (${consent.merchant_policy_ack ?? "undisclosed"}).`,
      evidence: [
        at("/mandate/payload_sd/consent/merchant_policy_ack", consent.merchant_policy_ack),
      ],
    },
    {
      rule: "4.1.23.7",
      title: "Currency conversion consent",
      status: consent.merchant_policy_ack ? "evidenced" : "not_evidenced",
      statement: `The instruction is in ${f.currency}; the countersign binds that currency, and the merchant-policy consent was taken ${consent.merchant_policy_ack ?? "undisclosed"}.`,
      evidence: [at("/tee/countersign/currency", b.tee.countersign.currency)],
    },
    {
      rule: "4.1.23.8",
      title: "Order confirmation available for at least 120 days",
      status: "evidenced",
      statement:
        "The order confirmation below is part of the Alibi, appended to a public transparency log and anchored on chain, so it stays available past the retention period.",
      evidence: [at("/alibi_id", b.alibi_id), at("/anchor/tx_hash", b.anchor?.tx_hash)],
    },
    {
      rule: "4.1.23.9",
      title: "Recurring instruction acknowledgement",
      status: flag(consent.recurrence_ack),
      statement: consent.recurrence_ack
        ? "The cardholder acknowledged that the instruction recurs until changed, cancelled or expired."
        : "The instruction is not recurring; the cardholder gave no recurrence acknowledgement.",
      evidence: [at("/mandate/payload_sd/consent/recurrence_ack", consent.recurrence_ack)],
    },
    {
      rule: "4.1.23.10",
      title: "Cardholder responsibility for the agent's actions",
      status: "informational",
      statement:
        "The cardholder acknowledged it (4.1.23.3); Keelson's Alibi shows whether the agent stayed within the instruction.",
      evidence: [],
    },
  ];

  const login = m.user?.app_login_id;
  const device = m.risk_data?.device_fp;
  const ip = m.risk_data?.ip;
  const elements: Ce3Element[] = [
    login
      ? { element: "account_login_id", status: "provided", value: login }
      : { element: "account_login_id", status: "withheld" },
    device
      ? device.length >= MIN_FINGERPRINT
        ? { element: "device_fingerprint", status: "provided", value: device }
        : {
            element: "device_fingerprint",
            status: "below_minimum",
            value: device,
            note: `CE3.0 requires at least ${MIN_FINGERPRINT} characters.`,
          }
      : { element: "device_fingerprint", status: "withheld" },
    ip
      ? { element: "ip_address", status: "provided", value: ip }
      : { element: "ip_address", status: "withheld" },
    opts.shipping
      ? { element: "shipping_address", status: "provided", value: opts.shipping }
      : { element: "shipping_address", status: "not_available" },
    {
      element: "prior_transactions",
      status: "merchant_to_supply",
      note: "Two prior undisputed transactions 120 to 365 days old come from the merchant's records.",
    },
  ];

  const description = f.lines.map((l) => `${l.quantity} × ${l.title}`).join("; ");
  return {
    type: PACK_TYPE,
    rules: RULES_EDITION,
    generated_at: opts.now.toISOString(),
    transaction: {
      alibi_id: b.alibi_id,
      decision: f.decision,
      countersigned_at: iso(f.issuedAt),
      amount_minor: f.totalMinor,
      currency: f.currency,
      merchant: f.merchant,
      ...(f.paypal
        ? {
            paypal: {
              order_id: f.paypal.order_id,
              ...(f.paypal.capture_id ? { capture_id: f.paypal.capture_id } : {}),
              ...(f.paypal.transaction_id ? { transaction_id: f.paypal.transaction_id } : {}),
            },
          }
        : {}),
    },
    requirements,
    ce3: { dispute_condition: "10.4", elements },
    order_confirmation: {
      description,
      ...(f.merchant.website ? { merchant_contact: f.merchant.website } : {}),
      total_minor: f.totalMinor,
      currency: f.currency,
      return_policy:
        f.returnDays > 0
          ? `${f.returnDays}-day returns${f.returnsFree ? ", free" : ""}`
          : "No returns stated",
      available_at: opts.alibiUrl,
      retained_until: new Date(f.issuedAt * 1000 + RETENTION_DAYS * DAY).toISOString(),
    },
    verify_url: verifyUrl(b),
  };
}
