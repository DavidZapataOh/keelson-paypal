import type { AlibiBundle } from "@keelson/alibi";
import { type Cart, CURRENCIES, type CurrencyCode, fromPayPalAmount } from "@keelson/core";
import { type Disclosed, decodeDisclosed, type Mandate, type UserAuth } from "@keelson/mandate";

/** One purchased line, in minor units of the purchase currency. */
export interface Line {
  sku: string;
  title: string;
  quantity: number;
  unitMinor: number;
}

/** A merchant as the standards name it. */
export interface Merchant {
  id: string;
  name: string;
  website?: string;
}

/**
 * What an Alibi proves about one purchase. Amount, currency, times, hashes and decision are the
 * enclaves' countersigned values; lines, breakdown and personal data exist only when the Alibi
 * discloses them, and are never derived from other fields.
 */
export interface PurchaseFacts {
  alibiId: string;
  requestId: `0x${string}`;
  decision: "allow" | "deny";
  failedFieldsMask: string;
  /** Seconds since the epoch. */
  issuedAt: number;
  expiresAt: number;
  /** ISO 4217, upper case. */
  currency: string;
  totalMinor: number;
  merchant: Merchant;
  /** The PayPal merchant id, or the card network's merchant id. */
  payee: string;
  rail: "paypal" | "card";
  /** The PayPal capture id, or the approved card authorization's id. */
  confirmationId?: string;
  orderId?: string;
  card?: { issuer: string; lastFour: string };
  lines?: Line[];
  breakdown?: { items: number; tax: number; shipping: number; discount: number };
  mandateHash: `0x${string}`;
  cartHash: `0x${string}`;
  mandate: Disclosed<Mandate>;
  /** The open mandate as the enclave issued it. */
  l2: string;
  userAuth: UserAuth;
  personal?: { appLoginId?: string; deviceFp?: string; ip?: string };
  env: "sandbox" | "live";
}

interface CardSection {
  issuer: string;
  last_four: string;
  authorizations: {
    id: string;
    approved: boolean;
    merchant_name: string;
    network_id: string;
  }[];
}

const ARBITRUM_ONE = 42161;

function alphaOf(numeric: string): string {
  const code = (Object.keys(CURRENCIES) as CurrencyCode[]).find(
    (c) => String(CURRENCIES[c].numeric) === numeric,
  );
  if (!code) throw new RangeError(`unknown ISO 4217 numeric currency ${numeric}`);
  return code;
}

/** The allowed merchant with `id`, from the disclosed `checkout.allowed_merchants`. */
function allowedMerchant(m: Disclosed<Mandate>, id: string): Merchant | undefined {
  for (const c of m.checkout?.constraints ?? []) {
    if (c?.type !== "checkout.allowed_merchants") continue;
    const found = (c.allowed ?? []).find((x) => x?.id === id);
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
    for (const line of c.items ?? []) {
      for (const a of line?.acceptable_items ?? []) {
        if (a?.id && a.title) titles.set(a.id, a.title);
      }
    }
  }
  return titles;
}

/** Reads an Alibi's purchase into the facts the exports state. */
export function purchaseFacts(b: AlibiBundle): PurchaseFacts {
  const cs = b.tee.countersign;
  const mandate = decodeDisclosed(b.mandate.payload_sd, b.mandate.disclosures);
  const cart = b.cart as unknown as Cart | undefined;
  const card = b.card as unknown as CardSection | undefined;
  const approved = card?.authorizations.find((a) => a.approved);
  const ctxMerchant = (b.eval.context as { merchant?: string }).merchant;
  const titles = itemTitles(mandate);

  let merchant: Merchant;
  let payee: string;
  if (card) {
    const auth = approved ?? card.authorizations[0];
    merchant = { id: auth?.network_id ?? "", name: auth?.merchant_name ?? "" };
    payee = merchant.id;
  } else {
    const id = cart?.merchant ?? ctxMerchant ?? "";
    merchant = allowedMerchant(mandate, id) ?? { id, name: id };
    payee = b.paypal?.merchant_id ?? "";
  }

  const confirmationId = card ? approved?.id : b.paypal?.capture_id;
  const total = b.checkout ? fromPayPalAmount(b.checkout, cart) : undefined;
  const personal = {
    ...(mandate.user?.app_login_id ? { appLoginId: mandate.user.app_login_id } : {}),
    ...(mandate.risk_data?.device_fp ? { deviceFp: mandate.risk_data.device_fp } : {}),
    ...(mandate.risk_data?.ip ? { ip: mandate.risk_data.ip } : {}),
  };

  return {
    alibiId: b.alibi_id,
    requestId: cs.requestId as `0x${string}`,
    decision: cs.decision === "1" ? "allow" : "deny",
    failedFieldsMask: cs.failedFieldsMask,
    issuedAt: Number(cs.issuedAt),
    expiresAt: Number(cs.expiresAt),
    currency: alphaOf(cs.currency),
    totalMinor: Number(cs.amount),
    merchant,
    payee,
    rail: card ? "card" : "paypal",
    ...(confirmationId ? { confirmationId } : {}),
    ...(!card && b.paypal?.order_id ? { orderId: b.paypal.order_id } : {}),
    ...(card ? { card: { issuer: card.issuer, lastFour: card.last_four } } : {}),
    ...(cart
      ? {
          lines: cart.lines.map((l) => ({
            sku: l.sku,
            title: titles.get(l.sku) ?? l.sku,
            quantity: l.qty,
            unitMinor: l.unit_minor,
          })),
        }
      : {}),
    ...(total
      ? {
          breakdown: {
            items: Number(total.items),
            tax: Number(total.tax),
            shipping: Number(total.shipping),
            discount: Number(total.discount),
          },
        }
      : {}),
    mandateHash: cs.mandateHash as `0x${string}`,
    cartHash: cs.cartHash as `0x${string}`,
    mandate,
    l2: b.mandate.sd_jwt,
    userAuth: b.mandate.user_auth as unknown as UserAuth,
    ...(Object.keys(personal).length ? { personal } : {}),
    env: b.tee.domain.chain_id === ARBITRUM_ONE ? "live" : "sandbox",
  };
}
