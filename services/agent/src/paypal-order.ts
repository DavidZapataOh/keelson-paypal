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
  /** Its breakdown, all `0.00` for an order that has none. */
  subtotal: string;
  shipping: string;
  tax: string;
  /** The PayPal merchant id of the order's only payee. */
  payee: string;
}

/**
 * The query PayPal's Smart Payment Buttons send to read an order's total and payee
 * (`getSupplementalOrderInfo` in `@paypal/smart-payment-buttons`). The formatted amount is not
 * asked for: only the value and its ISO code.
 */
const QUERY =
  "query GetCheckoutDetails($orderID: String!) { checkoutSession(token: $orderID) { cart { intent amounts { subtotal { currencyValue currencyCode } shippingAndHandling { currencyValue currencyCode } tax { currencyValue currencyCode } total { currencyValue currencyCode } } } payees { merchantId } } }";

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

/** The buyer's funding options and PayPal's conversion of the order for each, signed in only. */
const FUNDING =
  "query GetFundingOptions($orderID: String!) { checkoutSession(token: $orderID) { fundingOptions { currencyConversion { rate from { currencyValue currencyCode } to { currencyValue currencyCode } } } } }";

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
          amounts?: Record<"subtotal" | "shippingAndHandling" | "tax" | "total", Amount>;
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
  const total = value(amounts?.total);
  const subtotal = value(amounts?.subtotal);
  const shipping = value(amounts?.shippingAndHandling);
  const tax = value(amounts?.tax);
  const payees = session?.payees;
  if (
    typeof intent !== "string" ||
    typeof currency !== "string" ||
    !/^[A-Z]{3}$/.test(currency) ||
    total === undefined ||
    subtotal === undefined ||
    shipping === undefined ||
    tax === undefined ||
    !Array.isArray(payees) ||
    payees.length !== 1
  ) {
    return undefined;
  }
  const payee = (payees[0] as { merchantId?: unknown } | null)?.merchantId;
  if (typeof payee !== "string" || !/^[0-9A-Z]{8,20}$/.test(payee)) return undefined;
  return { intent, currency, value: total, subtotal, shipping, tax, payee };
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
 * are the countersigned ones exactly, and so are its item total, shipping and tax unless PayPal
 * holds no breakdown for it.
 */
export function chargeProblem(charge: PayPalCharge, total: CheckoutTotal): string | undefined {
  const minor = (v: string) => minorOf(v, charge.currency);
  if (charge.currency !== total.currency || minor(charge.value) !== total.minor) {
    return `PayPal's order charges ${charge.currency} ${charge.value}`;
  }
  const parts = [charge.subtotal, charge.shipping, charge.tax].map(minor);
  if (parts.every((p) => p === 0)) return undefined;
  const [items, shipping, tax] = parts;
  if (items !== total.items || shipping !== total.shipping || tax !== total.tax) {
    return `PayPal's order splits its total into items ${charge.subtotal}, shipping ${charge.shipping} and tax ${charge.tax}`;
  }
  return undefined;
}

/**
 * The charge of the order the PayPal page in `page` is for, read from PayPal itself as PayPal's
 * buttons read it, and PayPal's conversions of it for the buyer's funding options. The requests go
 * to the page's origin with the session's cookies, outside the page, so no script on it can answer
 * them. Undefined when the page names no order or PayPal does not answer one charge. Neither the
 * token nor the answers leave this function but as the charge and the conversions.
 */
export async function readCharge(
  page: Page,
): Promise<{ charge: PayPalCharge; conversions: KnownConversion[] } | undefined> {
  const token = orderToken(page.url());
  const origin = URL.parse(page.url())?.origin;
  if (!token || !origin) return undefined;
  const ask = (name: string, query: string) =>
    page
      .context()
      .request.post(`${origin}/graphql?${name}`, {
        headers: {
          "content-type": "application/json",
          "x-app-name": "smart-payment-buttons",
          "paypal-client-context": token,
        },
        data: { query, variables: { orderID: token } },
        timeout: 15_000,
      })
      .then((res) => (res.ok() ? (res.json() as Promise<unknown>) : null))
      .catch(() => null);
  const [details, funding] = await Promise.all([
    ask("GetCheckoutDetails", QUERY),
    ask("GetFundingOptions", FUNDING),
  ]);
  const charge = chargeOf(details);
  return charge ? { charge, conversions: conversionsOf(funding) } : undefined;
}

/** PayPal's conversion of an order's total to the buyer's funding currency. */
export interface KnownConversion {
  /** The order total converted, as PayPal states it. */
  from: { currency: string; value: string };
  currency: string;
  rate: string;
  buyer: string;
}

/**
 * Every conversion a review page's GraphQL answer states for the buyer's funding options
 * (`checkoutSession.fundingOptions[].currencyConversion { rate from to }`), with plain decimal
 * values and ISO codes only; nothing else of the answer is kept.
 */
function conversionsOf(answer: unknown): KnownConversion[] {
  const options = (answer as { data?: { checkoutSession?: { fundingOptions?: unknown } } } | null)
    ?.data?.checkoutSession?.fundingOptions;
  if (!Array.isArray(options)) return [];
  const out: KnownConversion[] = [];
  for (const option of options) {
    const c = (option as { currencyConversion?: unknown } | null)?.currencyConversion as
      | {
          rate?: unknown;
          from?: { currencyValue?: unknown; currencyCode?: unknown };
          to?: { currencyValue?: unknown; currencyCode?: unknown };
        }
      | null
      | undefined;
    const rate = typeof c?.rate === "number" ? String(c.rate) : c?.rate;
    if (
      typeof rate !== "string" ||
      !VALUE.test(rate) ||
      typeof c?.from?.currencyValue !== "string" ||
      typeof c.from.currencyCode !== "string" ||
      typeof c.to?.currencyValue !== "string" ||
      typeof c.to.currencyCode !== "string" ||
      !VALUE.test(c.from.currencyValue) ||
      !VALUE.test(c.to.currencyValue) ||
      !/^[A-Z]{3}$/.test(c.from.currencyCode) ||
      !/^[A-Z]{3}$/.test(c.to.currencyCode)
    ) {
      continue;
    }
    out.push({
      from: { currency: c.from.currencyCode, value: c.from.currencyValue },
      currency: c.to.currencyCode,
      rate,
      buyer: c.to.currencyValue,
    });
  }
  return out;
}

/**
 * The total to countersign when PayPal's order adds tax or shipping to the countersigned items:
 * its own breakdown, when its item total is the countersigned one and its parts add up to its
 * total. Undefined otherwise.
 */
export function requoteOf(charge: PayPalCharge, total: CheckoutTotal): CheckoutTotal | undefined {
  if (charge.currency !== total.currency) return undefined;
  const [value, items, shipping, tax] = [
    charge.value,
    charge.subtotal,
    charge.shipping,
    charge.tax,
  ].map((v) => minorOf(v, charge.currency));
  if (
    value === undefined ||
    items !== total.items ||
    shipping === undefined ||
    tax === undefined ||
    value !== items + shipping + tax - total.discount ||
    value === total.minor
  ) {
    return undefined;
  }
  try {
    return checkoutTotal(charge.currency, { items, shipping, tax, discount: total.discount });
  } catch {
    return undefined;
  }
}
