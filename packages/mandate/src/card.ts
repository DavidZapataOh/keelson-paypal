import { toPayPalValue } from "@keelson/core";
import { hSd as hashSd, mandateChallenge } from "./challenge.ts";
import {
  anyItem,
  type Color,
  type Evidence,
  FIELD_IDS,
  type FieldId,
  fieldColors,
} from "./colors.ts";
import { mandateCommitment } from "./commitment.ts";
import { ANY_ITEM, CATEGORY_TABLE, type Mandate } from "./schema.ts";
import { buildSdPayload, decodeMandate } from "./sd.ts";
import { type SpcDetails, spcDetails } from "./spc.ts";

/** Who answers for a field of the mandate if it turns out wrong. */
export type Answerer = "Keelson" | "Agent operator" | "You";

/** One row of the mandate card: a field, what it says and who answers for it. */
export interface CardRow {
  field: FieldId;
  label: string;
  /** One entry per element for list-valued fields; the UI renders each on its own. */
  values: string[];
  color: Color;
  /** Who answers for this field if it turns out wrong. */
  answers: Answerer;
}

/** The mandate card the user reviews before signing. */
export interface Card {
  rows: CardRow[];
  /** Plain-language notes about what the mandate leaves open. */
  warnings: string[];
}

const ANSWERS: Record<Color, Answerer> = {
  green: "Keelson",
  amber: "Agent operator",
  gray: "You",
};

const LABELS: Record<FieldId, string> = {
  mode: "Mode",
  recurrence: "Recurring purchases",
  total: "Maximum total",
  currency: "Currency",
  budget: "Budget",
  merchant: "Merchant",
  deadline: "Buy by",
  quantity: "Quantity",
  agent: "Agent",
  bond: "Agent bond (minimum)",
  items: "Items",
  category: "Category",
  variant: "Variant",
  return_policy: "Returns",
  subjective: "Left to the agent's judgment",
  summary: "Request summary",
};

/** English names of {@link CATEGORY_TABLE} ids. */
export const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  "gpt:1": "Animals & Pet Supplies",
  "gpt:166": "Apparel & Accessories",
  "gpt:8": "Arts & Entertainment",
  "gpt:537": "Baby & Toddler",
  "gpt:111": "Business & Industrial",
  "gpt:141": "Cameras & Optics",
  "gpt:222": "Electronics",
  "gpt:412": "Food, Beverages & Tobacco",
  "gpt:436": "Furniture",
  "gpt:632": "Hardware",
  "gpt:469": "Health & Beauty",
  "gpt:536": "Home & Garden",
  "gpt:5181": "Luggage & Bags",
  "gpt:772": "Mature",
  "gpt:783": "Media",
  "gpt:922": "Office Supplies",
  "gpt:5605": "Religious & Ceremonial",
  "gpt:2092": "Software",
  "gpt:988": "Sporting Goods",
  "gpt:1239": "Toys & Games",
  "gpt:888": "Vehicles & Parts",
  "gpt:187": "Apparel & Accessories > Shoes",
};

/** Decimal places of the bond assets the card can format; other assets are shown in minor units. */
const ASSET_DECIMALS: Readonly<Record<string, number>> = { PYUSD: 6 };

const money = (m: Mandate, minor: number): string =>
  `${toPayPalValue({ currency: m.payment.currency, minor: BigInt(minor) })} ${m.payment.currency}`;

function bond(asset: string, min: number): string {
  const decimals = ASSET_DECIMALS[asset];
  if (decimals === undefined) return `${min} ${asset} (smallest unit)`;
  const scale = 10n ** BigInt(decimals);
  const n = BigInt(min);
  return `${n / scale}.${(n % scale).toString().padStart(decimals, "0")} ${asset}`;
}

function host(url: string): string {
  return new URL(url).host;
}

function values(m: Mandate): Partial<Record<FieldId, string[]>> {
  const out: Partial<Record<FieldId, string[]>> = {
    mode:
      m.mode === "autonomous"
        ? ["Autonomous: the agent buys without asking you again"]
        : ["Immediate: a single purchase now"],
    recurrence: [m.consent.recurrence_ack ? "Acknowledged" : "Not acknowledged"],
    currency: [m.payment.currency],
    agent: [`${m.agent.operator.agent_id} (${m.agent.operator.agent_registry})`],
    bond: [bond(m.agent.bond.asset, m.agent.bond.min)],
  };
  for (const c of m.payment.constraints) {
    if (c.type === "payment.amount_range") out.total = [money(m, c.max)];
    else if (c.type === "payment.budget") out.budget = [money(m, c.max)];
    else if (c.type === "payment.execution_date") out.deadline = [c.not_after];
  }
  for (const c of m.checkout.constraints) {
    if (c.type === "checkout.allowed_merchants") {
      out.merchant = c.allowed.map(
        (x) => `${x.name} (${host(x.website)}, PayPal ${x.paypal_merchant_id})`,
      );
    } else if (c.type === "checkout.line_items") {
      out.quantity = [String(c.items.reduce((n, i) => n + i.quantity, 0))];
      out.items = c.items.map((i) =>
        i.acceptable_items
          .map((a) => (a.id === ANY_ITEM ? `Any item ("${a.title}")` : (a.title ?? a.id)))
          .join(" or "),
      );
    } else if (c.type === "keelson.category") {
      const name = (id: string) => CATEGORY_LABELS[id] ?? id;
      out.category = [...c.allow.map(name), ...c.deny.map((id) => `Not ${name(id)}`)];
    } else if (c.type === "keelson.attributes") {
      out.variant = Object.entries(c.must).map(([k, v]) => `${k}: ${v}`);
    } else if (c.type === "keelson.returns") {
      out.return_policy = [
        c.min_days > 0
          ? `${c.min_days} days or more${c.free ? ", free" : ""}`
          : `${c.free ? "Free returns" : "Returns accepted"}, no minimum window`,
      ];
    }
  }
  if (m.intent.subjective.length > 0) out.subjective = m.intent.subjective;
  if (m.intent.prompt_summary !== "") out.summary = [m.intent.prompt_summary];
  return out;
}

/**
 * Renders the card the user signs. It is built only from the payload and its disclosures, which must
 * resolve every digest, so what the card shows is what the signed hash commits to.
 */
export function renderCard(payloadSd: object, disclosures: string[], evidence: Evidence): Card {
  const m = decodeMandate(payloadSd, disclosures);
  const colors = fieldColors(m, evidence);
  const shown = values(m);
  const rows: CardRow[] = [];
  for (const field of FIELD_IDS) {
    const color = colors[field];
    const fieldValues = shown[field];
    if (color === undefined || fieldValues === undefined) continue;
    rows.push({ field, label: LABELS[field], values: fieldValues, color, answers: ANSWERS[color] });
  }
  const warnings = m.intent.subjective.map(
    (s) => `"${s}" is a matter of taste: Keelson cannot check it, so you answer for it.`,
  );
  if (anyItem(m)) {
    warnings.push("The item title is a description; any item in the allowed categories matches.");
  }
  return { rows, warnings };
}

/** Everything {@link prepareSigning} derives from a mandate for the user to sign it. */
export interface Signing {
  /** The payload as signed: the mandate with `zk.commitment` set to `C_m`. */
  payloadSd: object;
  disclosures: string[];
  hSd: Uint8Array;
  cm: bigint;
  /** `C_m` as `0x`-prefixed hex: the `commitment` of `POST /v1/mandates`. */
  commitment: string;
  /** The passkey challenge `M`. */
  challenge: Uint8Array;
  card: Card;
  spc: SpcDetails;
}

/**
 * Builds the selectively disclosable payload, its commitment and challenge, the card to show and
 * the Secure Payment Confirmation details. `C_m` does not cover `zk.commitment`, so it is computed
 * first and written into the payload that `H_sd` and the challenge then cover.
 *
 * `ambiguous` lists the fields the compiler could not settle, as `POST /v1/mandates/compile`
 * returns them; the card shows them gray, answered by the user. Pass `[]` only for a mandate the
 * user wrote field by field.
 */
export async function prepareSigning(
  m: Mandate,
  salt: Uint8Array,
  evidence: Omit<Evidence, "ambiguous">,
  ambiguous: readonly FieldId[],
): Promise<Signing> {
  const cm = await mandateCommitment(m, salt);
  const commitment = `0x${cm.toString(16).padStart(64, "0")}`;
  const bound: Mandate = { ...m, zk: { commitment } };
  const { payloadSd, disclosures } = await buildSdPayload(bound, () =>
    crypto.getRandomValues(new Uint8Array(16)),
  );
  const h = hashSd(payloadSd);
  return {
    payloadSd,
    disclosures,
    hSd: h,
    cm,
    commitment,
    challenge: mandateChallenge(h, cm),
    card: renderCard(payloadSd, disclosures, { ...evidence, ambiguous: new Set(ambiguous) }),
    spc: spcDetails(bound),
  };
}
