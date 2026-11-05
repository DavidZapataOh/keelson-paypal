import { type Money, toPayPalValue } from "@keelson/core";
import { hSd as hashSd, mandateChallenge } from "./challenge.ts";
import { type Color, type Evidence, type FieldId, fieldColors } from "./colors.ts";
import { mandateCommitment } from "./commitment.ts";
import type { Mandate } from "./schema.ts";
import { buildSdPayload, decodeMandate } from "./sd.ts";

export type Answerer = "Keelson" | "Agent operator" | "You";

export interface CardRow {
  field: FieldId;
  label: string;
  value: string;
  color: Color;
  /** Who answers for this field if it turns out wrong. */
  answers: Answerer;
}

export interface Card {
  rows: CardRow[];
  warnings: string[];
}

const ANSWERS: Record<Color, Answerer> = {
  green: "Keelson",
  amber: "Agent operator",
  gray: "You",
};

const LABELS: Record<FieldId, string> = {
  total: "Total",
  currency: "Currency",
  budget: "Budget",
  merchant: "Merchant",
  deadline: "Buy by",
  quantity: "Quantity",
  agent: "Agent",
  bond: "Agent bond (minimum, minor units)",
  items: "Items",
  category: "Category",
  variant: "Variant",
  return_policy: "Returns",
  subjective: "Left to the agent's judgment",
};

const money = (m: Mandate, minor: number): string =>
  `${toPayPalValue({ currency: m.payment.currency, minor: BigInt(minor) } satisfies Money)} ${m.payment.currency}`;

function values(m: Mandate): Partial<Record<FieldId, string>> {
  const out: Partial<Record<FieldId, string>> = {
    currency: m.payment.currency,
    agent: `${m.agent.operator.agent_id} (${m.agent.operator.agent_registry})`,
    bond: `${m.agent.bond.min} ${m.agent.bond.asset}`,
  };
  for (const c of m.payment.constraints) {
    if (c.type === "payment.amount_range") out.total = money(m, c.max);
    else if (c.type === "payment.budget") out.budget = money(m, c.max);
    else if (c.type === "payment.execution_date") out.deadline = c.not_after;
  }
  for (const c of m.checkout.constraints) {
    if (c.type === "checkout.allowed_merchants") {
      out.merchant = c.allowed.map((x) => x.name).join(", ");
    } else if (c.type === "checkout.line_items") {
      out.quantity = String(c.items.reduce((n, i) => n + i.quantity, 0));
      out.items = c.items
        .map((i) => i.acceptable_items.map((a) => a.title ?? a.id).join(" or "))
        .join(", ");
    } else if (c.type === "keelson.category") {
      out.category = c.allow.join(", ") + (c.deny.length > 0 ? ` (not ${c.deny.join(", ")})` : "");
    } else if (c.type === "keelson.attributes") {
      out.variant = Object.entries(c.must)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
    } else if (c.type === "keelson.returns") {
      out.return_policy = `${c.min_days} days or more${c.free ? ", free" : ""}`;
    }
  }
  if (m.intent.subjective.length > 0) out.subjective = m.intent.subjective.join(", ");
  return out;
}

const ORDER: readonly FieldId[] = [
  "total",
  "currency",
  "budget",
  "merchant",
  "deadline",
  "quantity",
  "items",
  "category",
  "variant",
  "return_policy",
  "agent",
  "bond",
  "subjective",
];

/**
 * Renders the card the user signs. It is built only from the payload and its disclosures, which must
 * resolve every digest, so what the card shows is what the signed hash commits to.
 */
export function renderCard(payloadSd: object, disclosures: string[], evidence: Evidence): Card {
  const m = decodeMandate(payloadSd, disclosures);
  const colors = fieldColors(m, evidence);
  const shown = values(m);
  const rows: CardRow[] = [];
  for (const field of ORDER) {
    const color = colors[field];
    const value = shown[field];
    if (color === undefined || value === undefined) continue;
    rows.push({ field, label: LABELS[field], value, color, answers: ANSWERS[color] });
  }
  const warnings = m.intent.subjective.map(
    (s) => `"${s}" is a matter of taste: Keelson cannot check it, so you answer for it.`,
  );
  return { rows, warnings };
}

export interface Signing {
  payloadSd: object;
  disclosures: string[];
  hSd: Uint8Array;
  cm: bigint;
  /** The passkey challenge `M`. */
  challenge: Uint8Array;
  card: Card;
}

/** Builds the selectively disclosable payload, its commitment and challenge, and the card to show. */
export async function prepareSigning(
  m: Mandate,
  salt: Uint8Array,
  evidence: Evidence,
): Promise<Signing> {
  const { payloadSd, disclosures } = await buildSdPayload(m, () =>
    crypto.getRandomValues(new Uint8Array(16)),
  );
  const h = hashSd(payloadSd);
  const cm = await mandateCommitment(m, salt);
  return {
    payloadSd,
    disclosures,
    hSd: h,
    cm,
    challenge: mandateChallenge(h, cm),
    card: renderCard(payloadSd, disclosures, evidence),
  };
}
