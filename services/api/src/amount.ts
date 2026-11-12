import {
  type CheckoutTotal,
  CheckoutTotalError,
  CURRENCIES,
  type CurrencyCode,
  checkoutTotal,
  fromPayPalValue,
} from "@keelson/core";

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
