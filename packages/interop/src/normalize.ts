import { ANY_ITEM, CATEGORY_LABELS, type Disclosed, type Mandate } from "@keelson/mandate";
import type { Merchant } from "./facts.ts";

/** A `checkout.line_items` entry: one of `acceptable` items, `quantity` times. */
interface LineRequirement {
  id: string;
  acceptable: { id: string; title: string }[];
  quantity: number;
}

/**
 * A mandate's constraints as the standards can state them. The constraints only Keelson defines
 * (`keelson.category`, `keelson.attributes`, `keelson.returns`, `payment.card_controls`) are not
 * exported as constraint types, since AP2 and VI fail any constraint they do not know; each one
 * is described in `notes` instead.
 */
export interface Normalized {
  currency: string;
  merchants: Merchant[];
  /** Payees, by PayPal merchant id. */
  payees: Merchant[];
  lines: LineRequirement[];
  /** Per-purchase cap, minor units. */
  maxAmount?: number;
  /** Total budget, minor units. */
  budget?: number;
  /** RFC 3339. */
  notAfter?: string;
  notes: string[];
}

/** One sentence per Keelson-only constraint, as the export's informative notes. */
function note(c: { type?: string } & Record<string, unknown>): string | undefined {
  switch (c.type) {
    case "keelson.category": {
      const label = (ids: unknown) =>
        ((ids as string[] | undefined) ?? []).map((id) => CATEGORY_LABELS[id] ?? id).join(", ");
      const deny = label(c.deny);
      return `keelson.category: only ${label(c.allow)}${deny ? `; never ${deny}` : ""}.`;
    }
    case "keelson.attributes":
      return `keelson.attributes: ${Object.entries((c.must as Record<string, string>) ?? {})
        .map(([k, v]) => `${k} = ${v}`)
        .join(", ")}.`;
    case "keelson.returns":
      return `keelson.returns: at least ${String(c.min_days)} days to return${c.free ? ", free" : ""}.`;
    case "payment.card_controls":
      return "payment.card_controls: paid with a single-use card limited to the allowed merchant categories.";
    default:
      return undefined;
  }
}

/** The standards' view of a (possibly partly disclosed) mandate. */
export function normalize(m: Disclosed<Mandate>): Normalized {
  const merchants: (Merchant & { paypal_merchant_id?: string })[] = [];
  const lines: LineRequirement[] = [];
  const notes: string[] = [];
  for (const c of m.checkout?.constraints ?? []) {
    if (!c) continue;
    if (c.type === "checkout.allowed_merchants") {
      for (const x of (c as Disclosed<{ allowed: (Merchant & { paypal_merchant_id?: string })[] }>)
        .allowed ?? []) {
        if (x?.id && x.name) merchants.push(x as Merchant & { paypal_merchant_id?: string });
      }
    } else if (c.type === "checkout.line_items") {
      const items = (
        c as Disclosed<{
          items: {
            id: string;
            acceptable_items: { id: string; title?: string }[];
            quantity: number;
          }[];
        }>
      ).items;
      for (const line of items ?? []) {
        if (!line?.id || !line.quantity) continue;
        const acceptable = (line.acceptable_items ?? [])
          .filter((a): a is { id: string; title?: string } => Boolean(a?.id))
          .map((a) => ({ id: a.id, title: a.title?.trim() || a.id }));
        if (acceptable.some((a) => a.id === ANY_ITEM)) {
          notes.push(`checkout.line_items: any item described as "${acceptable[0]?.title}".`);
        }
        lines.push({ id: line.id, acceptable, quantity: line.quantity });
      }
    } else {
      const n = note(c as { type?: string } & Record<string, unknown>);
      if (n) notes.push(n);
    }
  }
  const out: Normalized = {
    currency: m.payment?.currency ?? "",
    merchants: merchants.map(({ id, name, website }) => ({
      id,
      name,
      ...(website ? { website } : {}),
    })),
    payees: [],
    lines,
    notes,
  };
  for (const c of m.payment?.constraints ?? []) {
    if (!c) continue;
    switch (c.type) {
      case "payment.amount_range":
        if (c.max !== undefined) out.maxAmount = c.max;
        break;
      case "payment.budget":
        if (c.max !== undefined) out.budget = c.max;
        break;
      case "payment.execution_date":
        if (c.not_after) out.notAfter = c.not_after;
        break;
      case "payment.allowed_payees":
        for (const p of c.allowed ?? []) {
          // A payee is the PayPal account of an allowed merchant; with a single merchant it is that one's.
          const of =
            merchants.find((x) => x.paypal_merchant_id === p?.paypal_merchant_id) ??
            (merchants.length === 1 ? merchants[0] : undefined);
          if (p?.paypal_merchant_id) {
            out.payees.push({
              id: p.paypal_merchant_id,
              name: of?.name ?? p.paypal_merchant_id,
              ...(of?.website ? { website: of.website } : {}),
            });
          }
        }
        break;
      default: {
        const n = note(c as { type?: string } & Record<string, unknown>);
        if (n) notes.push(n);
      }
    }
  }
  return out;
}
