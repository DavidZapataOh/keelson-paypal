import type { Cart } from "./cart.ts";
import { CURRENCIES, type CurrencyCode, fromPayPalValue, toPayPalValue } from "./money.ts";

/**
 * What a checkout charges, in minor units of `currency`: the cart's items, plus tax and
 * shipping, less discounts. `minor` is the total the buyer pays.
 */
export interface CheckoutTotal {
  currency: string;
  items: number;
  tax: number;
  shipping: number;
  discount: number;
  minor: number;
}

/** A PayPal Orders v2 money object. */
export interface PayPalMoney {
  currency_code: string;
  value: string;
}

/**
 * The `amount` of a PayPal Orders v2 purchase unit with the breakdown Keelson countersigns:
 * `value = item_total + tax_total + shipping − discount`.
 */
export interface PayPalAmount {
  currency_code: string;
  value: string;
  breakdown: {
    item_total: PayPalMoney;
    tax_total?: PayPalMoney;
    shipping?: PayPalMoney;
    discount?: PayPalMoney;
  };
}

export class CheckoutTotalError extends Error {}

const PARTS = ["items", "tax", "shipping", "discount"] as const;
/** The breakdown fields Keelson countersigns, and the part of the total each one is. */
const FIELDS = {
  item_total: "items",
  tax_total: "tax",
  shipping: "shipping",
  discount: "discount",
} as const;

const fail = (message: string): never => {
  throw new CheckoutTotalError(message);
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Throws unless `v` is an object whose keys are all among `allowed`. */
function only(v: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  if (!isObject(v)) return fail(`${what} is not an object`);
  const extra = Object.keys(v).find((k) => !allowed.includes(k));
  if (extra !== undefined) fail(`${what} has a field Keelson does not countersign: ${extra}`);
  return v;
}

/** The PayPal decimal string of `minor` units, or a {@link CheckoutTotalError}. */
function write(currency: CurrencyCode, minor: number): string {
  try {
    return toPayPalValue({ currency, minor: BigInt(minor) });
  } catch {
    return fail(`${currency} cannot be written as ${minor} minor units`);
  }
}

/**
 * The total of a checkout from its parts. Every part is a whole, non-negative number of minor
 * units PayPal can write in `currency`, and so is the total.
 */
export function checkoutTotal(
  currency: string,
  parts: { items: number; tax?: number; shipping?: number; discount?: number },
): CheckoutTotal {
  if (!Object.hasOwn(CURRENCIES, currency)) fail(`unsupported currency: ${currency}`);
  const t: CheckoutTotal = {
    currency,
    items: parts.items,
    tax: parts.tax ?? 0,
    shipping: parts.shipping ?? 0,
    discount: parts.discount ?? 0,
    minor: 0,
  };
  for (const k of PARTS) {
    if (!Number.isSafeInteger(t[k]) || t[k] < 0) fail(`${k} is not a whole amount`);
    write(currency as CurrencyCode, t[k]);
  }
  const minor = BigInt(t.items) + BigInt(t.tax) + BigInt(t.shipping) - BigInt(t.discount);
  if (minor < 0n || minor > BigInt(Number.MAX_SAFE_INTEGER))
    fail("the total is not a whole amount");
  t.minor = Number(minor);
  write(currency as CurrencyCode, t.minor);
  return t;
}

/** The PayPal amount of a checkout total; parts that are zero, but the items, are left out. */
export function toPayPalAmount(t: CheckoutTotal): PayPalAmount {
  const currency = t.currency as CurrencyCode;
  const money = (minor: number) => ({ currency_code: t.currency, value: write(currency, minor) });
  return {
    currency_code: t.currency,
    value: money(t.minor).value,
    breakdown: {
      item_total: money(t.items),
      ...(t.tax > 0 ? { tax_total: money(t.tax) } : {}),
      ...(t.shipping > 0 ? { shipping: money(t.shipping) } : {}),
      ...(t.discount > 0 ? { discount: money(t.discount) } : {}),
    },
  };
}

/**
 * Reads a PayPal amount as the checkout total it states, as Keelson's engine reconciles it: one
 * currency throughout, an item total, every value a PayPal decimal, and the parts adding up to
 * the value. With `cart`, the currency must be the cart's and the item total the sum of its lines.
 * Refuses the breakdown fields Keelson does not countersign (handling, insurance, shipping
 * discount) and any field PayPal does not define.
 */
export function fromPayPalAmount(amount: unknown, cart?: Cart): CheckoutTotal {
  const a = only(amount, ["currency_code", "value", "breakdown"], "the amount");
  const currency = a.currency_code;
  if (typeof currency !== "string" || !Object.hasOwn(CURRENCIES, currency)) {
    return fail("the amount's currency is not supported");
  }
  if (cart && cart.currency !== currency) fail("the amount's currency is not the cart's");
  const read = (m: unknown, what: string): number => {
    const v = only(m, ["currency_code", "value"], what);
    if (v.currency_code !== currency) fail(`${what} is in another currency`);
    if (typeof v.value !== "string") return fail(`${what} has no value`);
    let minor: bigint;
    try {
      minor = fromPayPalValue(currency as CurrencyCode, v.value).minor;
    } catch {
      return fail(`${what} is not a PayPal amount`);
    }
    if (minor < 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${what} is out of range`);
    return Number(minor);
  };
  const breakdown = only(a.breakdown, Object.keys(FIELDS), "the breakdown");
  if (breakdown.item_total === undefined) fail("the breakdown has no item total");
  const parts = { items: 0, tax: 0, shipping: 0, discount: 0 };
  for (const [field, part] of Object.entries(FIELDS)) {
    if (breakdown[field] !== undefined) parts[part] = read(breakdown[field], field);
  }
  const value = read({ currency_code: currency, value: a.value }, "the value");
  const t = checkoutTotal(currency, parts);
  if (t.minor !== value) fail("the breakdown does not add up to the value");
  if (cart) {
    const items = cart.lines.reduce((sum, l) => sum + BigInt(l.qty) * BigInt(l.unit_minor), 0n);
    if (items !== BigInt(t.items)) fail("the item total is not the cart's");
  }
  return t;
}
