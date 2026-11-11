import type { AlibiBundle } from "@keelson/alibi";
import { type Cart, fromPayPalAmount, type PayPalAmount } from "@keelson/core";
import { type Disclosed, decodeDisclosed, type Mandate } from "@keelson/mandate";

/** A merchant as AP2, VI and UCP name it. */
export interface Merchant {
  id: string;
  name: string;
  website?: string;
}

/** One purchased line, in minor units of the purchase currency. */
export interface Line {
  sku: string;
  title: string;
  quantity: number;
  unitMinor: number;
}

/** What an Alibi proves about one purchase, read from its signed and disclosed sections. */
export interface PurchaseFacts {
  alibiId: string;
  decision: "allow" | "deny";
  /** The countersign's `issuedAt`, in seconds since the epoch. */
  issuedAt: number;
  currency: string;
  totalMinor: number;
  /** The checkout breakdown, when the Alibi discloses it. */
  breakdown?: { items: number; tax: number; shipping: number; discount: number };
  merchant: Merchant;
  /** The payee's PayPal merchant id, for a PayPal purchase. */
  payee?: string;
  lines: Line[];
  returnDays: number;
  returnsFree: boolean;
  paypal?: AlibiBundle["paypal"];
  card?: { issuer: string; lastFour: string };
  mandateHash: string;
  mandate: Disclosed<Mandate>;
}

/** The mandate an Alibi carries, with the disclosures it carries applied. */
export const alibiMandate = (b: AlibiBundle): Disclosed<Mandate> =>
  decodeDisclosed(b.mandate.payload_sd, b.mandate.disclosures);

/** The allowed merchant with `id`, from the disclosed `checkout.allowed_merchants`. */
function mandateMerchant(m: Disclosed<Mandate>, id: string): Merchant | undefined {
  for (const c of m.checkout?.constraints ?? []) {
    if (c?.type !== "checkout.allowed_merchants") continue;
    const found = (
      c as { allowed?: Disclosed<Merchant & { paypal_merchant_id?: string }>[] }
    ).allowed?.find((x) => x?.id === id);
    if (found?.id && found.name) {
      return {
        id: found.id,
        name: found.name,
        ...(found.website ? { website: found.website } : {}),
      };
    }
  }
  return undefined;
}

/** Titles of the acceptable items the mandate discloses, by id. */
function itemTitles(m: Disclosed<Mandate>): Map<string, string> {
  const titles = new Map<string, string>();
  for (const c of m.checkout?.constraints ?? []) {
    if (c?.type !== "checkout.line_items") continue;
    for (const line of (
      c as Disclosed<{ items: { acceptable_items: { id: string; title?: string }[] }[] }>
    ).items ?? []) {
      for (const a of line?.acceptable_items ?? []) {
        if (a?.id && a.title) titles.set(a.id, a.title);
      }
    }
  }
  return titles;
}

interface EvalContext {
  currency: string;
  total_minor: number;
  merchant: string;
  max_unit_minor?: number;
  return_days?: number;
  returns_free?: boolean;
  variants?: { sku: string }[];
  quantities?: [{ sku: string }, number][];
}

/**
 * The facts of the Alibi's purchase. Lines come from the disclosed cart; an Alibi issued before
 * the cart was disclosed gives them from the evaluation context, whose single-line carts have a
 * unit price equal to the total.
 */
export function purchaseFacts(b: AlibiBundle): PurchaseFacts {
  const mandate = alibiMandate(b);
  const ctx = b.eval.context as unknown as EvalContext;
  const cart = b.cart as unknown as Cart | undefined;
  const titles = itemTitles(mandate);
  const title = (sku: string) => titles.get(sku) ?? sku;
  const lines: Line[] = cart
    ? cart.lines.map((l) => ({
        sku: l.sku,
        title: title(l.sku),
        quantity: l.qty,
        unitMinor: l.unit_minor,
      }))
    : (ctx.variants ?? []).map((v) => {
        const quantity = ctx.quantities?.find(([q]) => q.sku === v.sku)?.[1] ?? 1;
        return {
          sku: v.sku,
          title: title(v.sku),
          quantity,
          unitMinor:
            ctx.variants?.length === 1
              ? Math.floor(ctx.total_minor / quantity)
              : (ctx.max_unit_minor ?? 0),
        };
      });
  const total = b.checkout
    ? fromPayPalAmount(b.checkout as unknown as PayPalAmount, cart)
    : undefined;
  const merchantId = cart?.merchant ?? ctx.merchant;
  const merchant = mandateMerchant(mandate, merchantId) ?? { id: merchantId, name: merchantId };
  const currency = total?.currency ?? cart?.currency ?? ctx.currency;
  return {
    alibiId: b.alibi_id,
    decision: b.eval.decision,
    issuedAt: Number(b.tee.countersign.issuedAt),
    currency,
    totalMinor: Number(b.tee.countersign.amount),
    ...(total
      ? {
          breakdown: {
            items: total.items,
            tax: total.tax,
            shipping: total.shipping,
            discount: total.discount,
          },
        }
      : {}),
    merchant,
    ...(b.paypal?.merchant_id ? { payee: b.paypal.merchant_id } : {}),
    lines,
    returnDays: cart?.return_days ?? ctx.return_days ?? 0,
    returnsFree: cart?.returns_free ?? ctx.returns_free ?? false,
    ...(b.paypal ? { paypal: b.paypal } : {}),
    ...(b.card ? { card: { issuer: b.card.issuer, lastFour: b.card.last_four } } : {}),
    mandateHash: b.tee.countersign.mandateHash,
    mandate,
  };
}
