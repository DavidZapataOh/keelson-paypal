import { type CheckoutTotal, checkoutTotal } from "@keelson/core";
import type { Page } from "playwright";
import { minorDigits } from "./amounts.ts";

/** What PayPal's checkout session charges, as PayPal's own Smart Payment Buttons read it. */
export interface PayPalCharge {
  /** `SALE` for an order captured at once, `AUTHORIZE` for one authorized first. */
  intent: string;
  currency: string;
  /** The order's total as PayPal's API writes values: `2.95`, `1500`. */
  value: string;
  /**
   * Its breakdown, all `0.00` for an order that has none: the item total; shipping, handling and
   * insurance less any shipping discount; tax and duties; and the discount.
   */
  subtotal: string;
  shipping: string;
  tax: string;
  discount: string;
  /** The PayPal merchant id of the order's only payee. */
  payee: string;
}

/**
 * The query PayPal's Smart Payment Buttons send to read an order's total and payee
 * (`getSupplementalOrderInfo` in `@paypal/smart-payment-buttons`). The formatted amount is not
 * asked for: only the value and its ISO code.
 */
const QUERY =
  "query GetCheckoutDetails($orderID: String!) { checkoutSession(token: $orderID) { cart { intent amounts { subtotal { currencyValue currencyCode } shippingAndHandling { currencyValue currencyCode } tax { currencyValue currencyCode } insurance { currencyValue currencyCode } smartDuty { currencyValue currencyCode } discount { currencyValue currencyCode } total { currencyValue currencyCode } } } payees { merchantId } } }";

/** An order id or its legacy EC token, as PayPal's checkout carries it in `token`. */
const TOKEN = /^(?:EC-)?[0-9A-Z]{17}$/;
const VALUE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

/** Whether `token` is an order id or its legacy EC token. */
const isOrderToken = (token: string): boolean => TOKEN.test(token);

/**
 * The order a PayPal checkout page is for: its one `token`, or undefined. A URL that carries two
 * names no order for sure.
 */
export function orderToken(url: string): string | undefined {
  const tokens = URL.parse(url)?.searchParams.getAll("token") ?? [];
  const [token] = tokens;
  return tokens.length === 1 && token && isOrderToken(token) ? token : undefined;
}

/**
 * The charge a `GetCheckoutDetails` answer states, or undefined unless it states exactly one.
 */
function chargeOf(answer: unknown): PayPalCharge | undefined {
  type Amount = { currencyValue?: unknown; currencyCode?: unknown } | null | undefined;
  const session = (answer as { data?: { checkoutSession?: unknown } } | null)?.data
    ?.checkoutSession as
    | {
        cart?: {
          intent?: unknown;
          amounts?: Record<
            | "subtotal"
            | "shippingAndHandling"
            | "tax"
            | "insurance"
            | "smartDuty"
            | "discount"
            | "total",
            Amount
          >;
        };
        payees?: unknown;
      }
    | undefined;
  if ((answer as { errors?: unknown } | null)?.errors !== undefined) return undefined;
  const intent = session?.cart?.intent;
  const amounts = session?.cart?.amounts;
  const currency = amounts?.total?.currencyCode;
  const value = (a: Amount) =>
    typeof a?.currencyValue === "string" &&
    VALUE.test(a.currencyValue) &&
    a.currencyCode === currency
      ? a.currencyValue
      : undefined;
  // Parts an order without them answers as null.
  const part = (a: Amount) => (a === null || a === undefined ? "0" : value(a));
  const sum = (...xs: (string | undefined)[]) => {
    if (typeof currency !== "string" || xs.some((x) => x === undefined)) return undefined;
    const digits = minorDigits(currency);
    const minor = xs.map((x) => minorOf(x as string, currency));
    if (minor.some((m) => m === undefined)) return undefined;
    const t = minor.reduce<number>((a, b) => a + (b as number), 0);
    return (t / 10 ** digits).toFixed(digits);
  };
  const total = value(amounts?.total);
  const subtotal = value(amounts?.subtotal);
  const shipping = sum(value(amounts?.shippingAndHandling), part(amounts?.insurance));
  const tax = sum(value(amounts?.tax), part(amounts?.smartDuty));
  const discount = sum(part(amounts?.discount));
  const payees = session?.payees;
  if (
    typeof intent !== "string" ||
    typeof currency !== "string" ||
    !/^[A-Z]{3}$/.test(currency) ||
    total === undefined ||
    subtotal === undefined ||
    shipping === undefined ||
    tax === undefined ||
    discount === undefined ||
    !Array.isArray(payees) ||
    payees.length !== 1
  ) {
    return undefined;
  }
  const payee = (payees[0] as { merchantId?: unknown } | null)?.merchantId;
  if (typeof payee !== "string" || !/^[0-9A-Z]{8,20}$/.test(payee)) return undefined;
  return { intent, currency, value: total, subtotal, shipping, tax, discount, payee };
}

/** A PayPal value in minor units of `currency`, or undefined when it has more decimals. */
function minorOf(value: string, currency: string): number | undefined {
  const digits = minorDigits(currency);
  const [whole = "", fraction = ""] = value.split(".");
  if (fraction.replace(/0+$/, "").length > digits) return undefined;
  return Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0").slice(0, digits) || 0);
}

/**
 * Why PayPal's order does not charge `total`, or undefined when it does: its currency and total
 * are the countersigned ones exactly, and so are its item total, shipping, tax and discount unless
 * PayPal holds no breakdown for it.
 */
export function chargeProblem(charge: PayPalCharge, total: CheckoutTotal): string | undefined {
  const minor = (v: string) => minorOf(v, charge.currency);
  if (charge.currency !== total.currency || minor(charge.value) !== total.minor) {
    return `PayPal's order charges ${charge.currency} ${charge.value}`;
  }
  const parts = [charge.subtotal, charge.shipping, charge.tax, charge.discount].map(minor);
  if (parts.every((p) => p === 0)) return undefined;
  const [items, shipping, tax, discount] = parts;
  if (
    items !== total.items ||
    shipping !== total.shipping ||
    tax !== total.tax ||
    discount !== total.discount
  ) {
    return `PayPal's order splits its total into items ${charge.subtotal}, shipping ${charge.shipping}, tax ${charge.tax} and discount ${charge.discount}`;
  }
  return undefined;
}

/**
 * The charge of the order the PayPal page in `page` is for, read from PayPal itself as PayPal's
 * buttons read it. The request goes to the page's origin with the session's cookies, outside the
 * page, so no script on it can answer it. Undefined when the page names no order or PayPal does
 * not answer one charge.
 */
export async function readCharge(page: Page): Promise<PayPalCharge | undefined> {
  const token = orderToken(page.url());
  const origin = URL.parse(page.url())?.origin;
  if (!token || !origin) return undefined;
  const details = await page
    .context()
    .request.post(`${origin}/graphql?GetCheckoutDetails`, {
      headers: {
        "content-type": "application/json",
        "x-app-name": "smart-payment-buttons",
        "paypal-client-context": token,
      },
      data: { query: QUERY, variables: { orderID: token } },
      timeout: 15_000,
    })
    .then((res) => (res.ok() ? (res.json() as Promise<unknown>) : null))
    .catch(() => null);
  return chargeOf(details);
}

/**
 * The total to countersign when PayPal's order adds tax or shipping to the countersigned items:
 * its own breakdown, when its item total is the countersigned one and its parts add up to its
 * total. Undefined otherwise.
 */
export function requoteOf(charge: PayPalCharge, total: CheckoutTotal): CheckoutTotal | undefined {
  if (charge.currency !== total.currency) return undefined;
  const [value, items, shipping, tax, discount] = [
    charge.value,
    charge.subtotal,
    charge.shipping,
    charge.tax,
    charge.discount,
  ].map((v) => minorOf(v, charge.currency));
  if (
    value === undefined ||
    items !== total.items ||
    shipping === undefined ||
    tax === undefined ||
    discount !== total.discount ||
    value !== items + shipping + tax - discount ||
    value === total.minor
  ) {
    return undefined;
  }
  try {
    return checkoutTotal(charge.currency, { items, shipping, tax, discount });
  } catch {
    return undefined;
  }
}
