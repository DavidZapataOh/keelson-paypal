import { type CheckoutTotal, CheckoutTotalError, checkoutTotal } from "./checkout.ts";
import { sha256, toHex } from "./hash.ts";
import { jcs } from "./jcs.ts";
import { CURRENCIES, type CurrencyCode, fromPayPalValue } from "./money.ts";

/**
 * What decided the amount a live checkout pays: PayPal's Orders API, the store's signature over
 * its cart, the user's passkey, or only PayPal's checkout page, which is never an authority.
 */
export type AmountAuthority =
  | "paypal_order"
  | "merchant_signed_cart"
  | "user_confirmed"
  | "checkout_page";

/** The fields of a PayPal order that decide what the buyer pays. */
export interface OrderFacts {
  orderId: string;
  status: string;
  intent: "CAPTURE" | "AUTHORIZE";
  /** `purchase_units[0].amount.currency_code`: the order's currency, never the buyer's. */
  currency: string;
  total: CheckoutTotal;
  /** Whether PayPal holds a breakdown for the order; without one only the total compares. */
  breakdown: boolean;
  /** `purchase_units[0].payee.merchant_id`. */
  payee: string;
  units: number;
}

/** A live checkout's amount, and what decided it. */
export interface AmountCheck {
  v: "keelson.amount_check/1";
  authority: AmountAuthority;
  /** For `paypal_order`: read with Keelson's own credentials, or for a connected merchant. */
  via?: "own" | "partner" | "ucp";
  read_by: "api" | "tee:A";
  /** SHA-256 of the PayPal order id: the id itself stays out of public copies. */
  order_id_hash: `0x${string}`;
  total: { currency: string; minor: number };
  payee: string;
  intent: "CAPTURE" | "AUTHORIZE";
  /** RFC 3339, UTC. */
  checked_at: string;
  /** What PayPal's checkout stated for the same order; one that disagrees never passes. */
  cross_check: "agrees" | "unavailable";
  evidence?: {
    /** The user's WebAuthn assertion over {@link amountConfirmChallenge}, base64url fields. */
    assertion?: {
      credentialId: string;
      authenticatorData: string;
      clientDataJSON: string;
      signature: string;
    };
  };
}

/** The field of a PayPal order that does not match what Keelson countersigned. */
export type MismatchField =
  | "currency"
  | "total"
  | "breakdown"
  | "payee"
  | "intent"
  | "units"
  | "status"
  | "order";

export class AmountMismatch extends Error {
  override name = "AmountMismatch";
  constructor(readonly field: MismatchField) {
    super(field);
  }
}

/** The statuses of an order the buyer can still pay. */
const PAYABLE: ReadonlySet<string> = new Set([
  "CREATED",
  "SAVED",
  "APPROVED",
  "PAYER_ACTION_REQUIRED",
]);
const PAYEE = /^[0-9A-Z]{8,20}$/;

type Money = { currency_code?: unknown; value?: unknown } | undefined;

/**
 * The facts of an Orders v2 order (`GET /v2/checkout/orders/{id}`): throws {@link AmountMismatch}
 * `units` for more than one purchase unit, `status` for one that can no longer be paid, and
 * `order` for anything that is not an order PayPal could have returned.
 */
export function orderFacts(order: unknown): OrderFacts {
  const o = order as {
    id?: unknown;
    status?: unknown;
    intent?: unknown;
    purchase_units?: unknown;
  } | null;
  const units = o?.purchase_units;
  if (typeof o?.id !== "string" || !Array.isArray(units) || units.length === 0) {
    throw new AmountMismatch("order");
  }
  if (units.length !== 1) throw new AmountMismatch("units");
  if (typeof o.status !== "string" || !PAYABLE.has(o.status)) throw new AmountMismatch("status");
  if (o.intent !== "CAPTURE" && o.intent !== "AUTHORIZE") throw new AmountMismatch("intent");
  const unit = units[0] as {
    amount?: Money & { breakdown?: Record<string, Money> };
    payee?: { merchant_id?: unknown };
  };
  const currency = unit.amount?.currency_code;
  const payee = unit.payee?.merchant_id;
  if (
    typeof currency !== "string" ||
    !Object.hasOwn(CURRENCIES, currency) ||
    typeof payee !== "string" ||
    !PAYEE.test(payee)
  ) {
    throw new AmountMismatch("order");
  }
  const minor = (m: Money): number => {
    if (m === undefined) return 0;
    if (m.currency_code !== currency || typeof m.value !== "string") {
      throw new AmountMismatch("order");
    }
    try {
      return Number(fromPayPalValue(currency as CurrencyCode, m.value).minor);
    } catch {
      throw new AmountMismatch("order");
    }
  };
  const value = minor(unit.amount);
  // PayPal answers `"breakdown": {}` for an order created without one.
  const b =
    unit.amount?.breakdown && Object.keys(unit.amount.breakdown).length > 0
      ? unit.amount.breakdown
      : undefined;
  let total: CheckoutTotal;
  try {
    total = b
      ? checkoutTotal(currency, {
          items: minor(b.item_total),
          tax: minor(b.tax_total),
          shipping: minor(b.shipping) + minor(b.handling) + minor(b.insurance),
          discount: minor(b.discount) + minor(b.shipping_discount),
        })
      : checkoutTotal(currency, { items: value });
  } catch (e) {
    if (e instanceof CheckoutTotalError) throw new AmountMismatch("order");
    throw e;
  }
  if (total.minor !== value) throw new AmountMismatch("order");
  return {
    orderId: o.id,
    status: o.status,
    intent: o.intent,
    currency,
    total,
    breakdown: b !== undefined,
    payee,
    units: 1,
  };
}

/**
 * Throws {@link AmountMismatch} unless the order charges exactly `total`: the same currency and
 * value, the same split into items, tax, shipping and discount when PayPal holds a breakdown, and
 * a payee `allowed` accepts.
 */
export function compareOrder(
  o: OrderFacts,
  total: CheckoutTotal,
  allowed: (payee: string) => boolean,
): void {
  if (o.currency !== total.currency) throw new AmountMismatch("currency");
  if (o.total.minor !== total.minor) throw new AmountMismatch("total");
  if (
    o.breakdown &&
    (o.total.items !== total.items ||
      o.total.tax !== total.tax ||
      o.total.shipping !== total.shipping ||
      o.total.discount !== total.discount)
  ) {
    throw new AmountMismatch("breakdown");
  }
  if (!allowed(o.payee)) throw new AmountMismatch("payee");
}

const encoder = new TextEncoder();

/** SHA-256 of a PayPal order id, as an {@link AmountCheck} names the order. */
export function orderIdHash(orderId: string): `0x${string}` {
  return toHex(sha256(encoder.encode(orderId)));
}

/** What the user confirms with their passkey for a live checkout. */
export interface AmountConfirmation {
  purchase_id: string;
  order_id_hash: `0x${string}`;
  currency: string;
  minor: number;
  payee: string;
}

const CONFIRM_DST = "keelson/amount-confirm/v1";

/**
 * The WebAuthn challenge of an amount confirmation:
 * `SHA-256("keelson/amount-confirm/v1" || 0x00 || JCS(confirmation))`.
 */
export function amountConfirmChallenge(c: AmountConfirmation): Uint8Array {
  const prefix = encoder.encode(CONFIRM_DST);
  const body = encoder.encode(
    jcs({
      purchase_id: c.purchase_id,
      order_id_hash: c.order_id_hash,
      currency: c.currency,
      minor: c.minor,
      payee: c.payee,
    }),
  );
  const input = new Uint8Array(prefix.length + 1 + body.length);
  input.set(prefix, 0);
  input.set(body, prefix.length + 1);
  return sha256(input);
}
