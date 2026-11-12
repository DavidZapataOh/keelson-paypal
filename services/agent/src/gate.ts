import { ToolError } from "@anthropic-ai/sdk/helpers/beta/toolsets";
import {
  type CheckoutTotal,
  type Conversion,
  DEFAULT_MAX_SPREAD_BPS,
  type FxReference,
  spreadBps,
} from "@keelson/core";
import type { Locator, Page } from "playwright";
import {
  decimalText,
  judge,
  type Money,
  minorDigits,
  type PageReading,
  pageLocales,
  rateBetween,
  readPage,
  type ShownConversion,
} from "./amounts.ts";
import { rows, type Seen, sanitize } from "./capture.ts";
import { type Funding, type PayForm, readFunding, readPayForm } from "./paypal-funding.ts";
import {
  chargeProblem,
  orderToken,
  type PayPalCharge,
  readCharge,
  requoteOf,
} from "./paypal-order.ts";
import { requote } from "./requote.ts";

/** Names of the controls that commit a payment, on a store's checkout or on PayPal. */
const PAY =
  /\b(pay(?: now| with paypal| \$?[\d.,]+)?|complete (?:purchase|order|payment)|place (?:your )?order|submit order|buy now|agree (?:and|&) (?:pay|continue)|continue to review(?: order)?|confirm (?:and|&) pay)\b/i;
/** Offers the buyer never takes: saving a payment method, installments or credit. */
const NEVER =
  /\b(save (?:paypal|my|your|card|this|payment)|for (?:future|faster)|remember (?:me|this)|pay (?:in \d|later|monthly|over time)|paypal credit|installments?)\b/i;
/**
 * PayPal's hosts, whose review page may show the total converted to the buyer's currency at the
 * rate PayPal writes on it.
 */
const PAYPAL_HOSTS = ["paypal.com", "*.paypal.com"];
/** The order intents a buyer's payment has: captured at once (`SALE`) or authorized first. */
const INTENTS: ReadonlySet<string> = new Set(["SALE", "AUTHORIZE"]);
/** How old the reference's rates may be: the provider updates them once a day. */
const REFERENCE_MAX_AGE_MS = 48 * 3600_000;
/** How long PayPal's checkout may take to settle before the gate reads it. */
const SETTLE_MS = 2_000;
/** The pause between the two reads of the Pay form, which must agree. */
const REREAD_MS = 250;
/** A store's checkout, on its own host: Shopify's `/checkouts/…`, and the usual `/checkout`. */
const CHECKOUT_PATH = /\/checkouts?(?:\/|$)/;

/**
 * What PayPal's data stated for a payment, for the log: where it was read, the instrument, the
 * amount charged to the buyer, the rate that amount gives for the order, and the rate PayPal shows.
 */
export interface FundingLog {
  sources: string[];
  instrument?: { type: string; lastDigits?: string };
  buyer?: string;
  /** The buyer's currency per unit of the order's, from the amount PayPal charges. */
  rate?: string;
  /** The rate PayPal shows for its conversion: `1 COP = 0.000290145 USD`. */
  quote?: string;
}

function fundingLog(total: CheckoutTotal, f: Partial<Funding>): FundingLog {
  const order = total.currency;
  const merchant = decimalText(total.minor, minorDigits(order));
  return {
    sources: f.sources ?? [],
    ...(f.instrument ? { instrument: f.instrument } : {}),
    ...(f.buyer ? { buyer: `${f.buyer.currency} ${f.buyer.value}` } : {}),
    ...(f.buyer && f.buyer.currency !== order
      ? { rate: rateBetween(merchant, f.buyer.value) }
      : {}),
    ...(f.quote
      ? {
          quote: f.quote.inverse
            ? `1 ${f.quote.currency} = ${f.quote.rate} ${order}`
            : `1 ${order} = ${f.quote.rate} ${f.quote.currency}`,
        }
      : {}),
  };
}

/** What the agent is about to do in the browser that could commit a payment. */
export type PayAction =
  | { kind: "click"; target: Locator }
  | { kind: "input"; target: Locator }
  | { kind: "point" }
  | { kind: "key" };

/**
 * Holds every action that could commit a payment until Keelson countersigned the cart: any action
 * on a checkout page (a checkout host such as PayPal, or a store's `/checkout`) and a click on a
 * pay control anywhere. Once Keelson countersigned the checkout's total, those actions go through
 * only on a page that labels exactly that total as its total or charge and shows no larger amount
 * that may be charged in its currency (see {@link charges}), and only while the store's own cart
 * (when it serves one) holds the countersigned items less discounts. Conversions of the total to
 * the buyer's currency, balances and rates do not count. Whatever the gate cannot read, it holds,
 * and logs the page's numbers with nothing of the buyer's. A page that shows another total, made
 * of the countersigned items and the tax and shipping it labels, is held with that total as its
 * re-quote: paying it waits for Keelson to countersign it too. On a checkout page, clicks by
 * coordinate, keys and typed text are refused always, as are saving a payment method,
 * installments and credit. Checkout hosts
 * are written like the browser's allowlist: exact, or `*.example.com` for its subdomains.
 *
 * On PayPal, PayPal's own data decides. Once the checkout has settled, the gate asks PayPal for
 * the order as PayPal's own buttons do, and pays only an order whose total is exactly the
 * countersigned value and currency, whose intent is a payment and whose only payee is the one the
 * mandate names, when it names one. It then reads what the Pay form submits (the funding
 * instrument and the conversion option) and PayPal's funding data for that instrument, which
 * states what PayPal charges the buyer: the order's total, or its `convertedAmount` in the buyer's
 * currency (see {@link readFunding}). A converted charge is paid only within the mandate's spread
 * of the reference rate Keelson fetched when it countersigned, at the rate the charge gives for
 * the order. Whatever PayPal's data does not state is held; the page's text can only hold: it
 * must show no larger charge, no other conversion, and rate lines that are PayPal's rate rounded.
 */
export class PayGate {
  readonly #checkoutHosts: readonly string[];
  readonly #convertHosts: readonly string[];
  readonly #cart: (() => Promise<Money | undefined>) | undefined;
  readonly #payee: string | undefined;
  readonly #maxSpreadBps: number;
  #total: CheckoutTotal | undefined;
  #reference: FxReference | undefined;
  /**
   * What the last pay action let through on PayPal paid: PayPal's order, what PayPal charges the
   * buyer for it and where that was read, and its conversion to the buyer's currency, if any.
   */
  paid: { charge: PayPalCharge; funding: FundingLog; conversion?: Conversion } | undefined;
  #requote: CheckoutTotal | undefined;
  /** Actions refused so far. */
  refused = 0;
  /**
   * Each page where a pay action was held for its total: the locale it was read in, the amounts
   * it showed in the cart's currency and those it labeled its total, and every number on it that
   * may be money, with its row's checkout words and region and nothing of the buyer's.
   */
  readonly held: {
    locale: string | null;
    amounts: string[];
    totals: string[];
    /**
     * The amounts under a sign the cart's currency shares with another on the page (`$ 10.236`),
     * read as the cart's currency; numbers with no sign, which may be the buyer's, are left out.
     */
    loose?: string[];
    unsure?: string;
    cart?: string;
    requote?: string;
    /** What PayPal's own data stated for the payment, as far as it was read. */
    paypal?: FundingLog;
    seen: Seen[];
  }[] = [];

  /**
   * `cart` reads what the store's own cart (Shopify's `/cart.js`) charges for its items, after
   * discounts and before tax and shipping: the structured amount a pay action is checked against
   * besides the page's text; undefined when it cannot be read.
   */
  constructor(o: {
    checkoutHosts: readonly string[];
    cart?: () => Promise<Money | undefined>;
    convertHosts?: readonly string[];
    /** The PayPal merchant id the mandate allows paying, when it names one. */
    payee?: string;
    /** The mandate's `fx.max_spread_bps`. */
    maxSpreadBps?: number;
  }) {
    this.#checkoutHosts = o.checkoutHosts;
    this.#convertHosts = o.convertHosts ?? PAYPAL_HOSTS;
    this.#cart = o.cart;
    this.#payee = o.payee;
    this.#maxSpreadBps = o.maxSpreadBps ?? DEFAULT_MAX_SPREAD_BPS;
  }

  /**
   * Opens the gate for the countersigned checkout total, and only for it, with the reference
   * rates bound into its evidence, if any: without them, a conversion is never paid.
   */
  allow(total: CheckoutTotal, reference?: FxReference): void {
    this.#total = total;
    this.#reference = reference;
    this.#requote = undefined;
    this.paid = undefined;
  }

  /**
   * The checkout total of the last page held for showing another one, made of the countersigned
   * items and its labeled tax and shipping; taken once. Paying it needs its own countersign.
   */
  takeRequote(): CheckoutTotal | undefined {
    const next = this.#requote;
    this.#requote = undefined;
    return next;
  }

  get open(): boolean {
    return this.#total !== undefined;
  }

  /**
   * The control's name as the page labels it (its text, label, title and value, read from the
   * control a click on `target` activates), and whether it is a box already checked, which
   * acting on unchecks.
   */
  static async #control(target: Locator): Promise<{ name: string; checked: boolean }> {
    const read = await target
      .evaluate((node) => {
        const el =
          node.closest(
            "button, a, label, [role=button], [role=link], [role=checkbox], [role=switch], input, select",
          ) ?? node;
        return {
          name: [
            el.textContent,
            el.getAttribute("aria-label"),
            el.getAttribute("title"),
            el instanceof HTMLInputElement ? el.value : "",
            el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : "",
            el.closest("label")?.textContent,
          ].join(" "),
          checked:
            (el instanceof HTMLInputElement && el.checked) ||
            el.getAttribute("aria-checked") === "true",
        };
      })
      .catch(() => ({ name: "", checked: false }));
    return { name: read.name.replace(/\s+/g, " "), checked: read.checked };
  }

  static #matches(hosts: readonly string[], host: string): boolean {
    return hosts.some((h) => (h.startsWith("*.") ? host.endsWith(h.slice(1)) : h === host));
  }

  #onCheckout(page: Page): boolean {
    const url = URL.parse(page.url());
    if (!url) return false;
    return PayGate.#matches(this.#checkoutHosts, url.hostname) || CHECKOUT_PATH.test(url.pathname);
  }

  #refuse(reason: string): never {
    this.refused++;
    throw new ToolError(`blocked: ${reason}`);
  }

  /** Throws the tool error the model receives when `action` must wait or is never taken. */
  async check(page: Page, action: PayAction): Promise<void> {
    const checkout = this.#onCheckout(page);
    // On a checkout page only a control the page names can be acted on: a click by coordinate,
    // a key or typed text could activate whatever has focus.
    if (checkout && !("target" in action)) {
      this.#refuse("on a checkout page, act only on a reference the page returned.");
    }
    const { name, checked } =
      "target" in action ? await PayGate.#control(action.target) : { name: "", checked: false };
    if (NEVER.test(name) && !checked) {
      this.#refuse("the buyer never saves a payment method, pays in installments or takes credit.");
    }
    if (!checkout && !(action.kind === "click" && PAY.test(name))) return;
    const total = this.#total;
    if (total === undefined) {
      this.#refuse(
        "this action can pay, and Keelson has not countersigned the cart. Paying waits for its 2-of-2 countersignature; do not try another way to pay.",
      );
    }
    const lang = await page.evaluate(() => document.documentElement.lang).catch(() => "");
    const converts = PayGate.#matches(this.#convertHosts, URL.parse(page.url())?.hostname ?? "");
    // On PayPal, the page is read once its checkout has settled, with the Pay form it submits.
    const form = converts ? await this.#settle(page, action) : undefined;
    // Every rendered frame's text: a total drawn inside a frame is on the page the buyer sees. A
    // frame that is not rendered (`display: none`) is not: its `innerText` is its whole source.
    const text = (
      await Promise.all(
        page.frames().map((f) =>
          f
            // biome-ignore lint/performance/useDomNodeTextContent: the amounts as the buyer sees them on the page.
            .evaluate(() => (document.body?.checkVisibility() ? document.body.innerText : ""))
            .catch(() => ""),
        ),
      )
    ).join("\n");
    // PayPal's `locale.x` names the locale it was asked for, not always the one it renders in
    // (`es_XC` on a page in English): there the page's own language decides.
    const locales = converts && lang ? pageLocales(lang, "") : pageLocales(lang, page.url());
    const read = readPage(text, locales, total.currency);
    const cart = this.#cart ? await this.#cart().catch(() => undefined) : undefined;
    const digits = minorDigits(total.currency);
    const show = (m: number) => `${total.currency} ${(m / 10 ** digits).toFixed(digits)}`;
    const cartOk =
      !this.#cart ||
      (cart?.currency === total.currency && cart.minor === total.items - total.discount);
    let paypal: { charge: PayPalCharge; funding: Funding } | undefined;
    let conversion: Conversion | undefined;
    if (converts) {
      paypal = await this.#order(page, form, total, show, read);
      const { buyer } = paypal.funding;
      if (buyer.currency !== total.currency) {
        const checked = this.#conversion(total, {
          currency: buyer.currency,
          rate: rateBetween(decimalText(total.minor, digits), buyer.value),
          buyer: buyer.value,
          locale: read.locale || "en",
        });
        if (typeof checked === "string") {
          this.held.push({
            locale: read.locale || null,
            amounts: read.minor.map(show),
            totals: read.totals.map(show),
            loose: read.shared.filter((a) => a.marks.length > 0).map((a) => show(a.value)),
            unsure: checked,
            paypal: fundingLog(total, paypal.funding),
            seen: sanitize(await rows(page), read.locale || "en", total.currency),
          });
          this.#refuse(checked);
        }
        conversion = checked;
      }
    }
    const quote = paypal?.funding.quote;
    const judged = judge(
      read,
      total.minor,
      total.currency,
      converts,
      !converts,
      conversion && {
        currency: conversion.buyer.currency,
        rate: conversion.rate,
        buyer: conversion.buyer.value,
        ...(quote ? { quote } : {}),
      },
    );
    if (!judged.ok || !cartOk) {
      // A re-quote is the page's largest amount, which it must label its total, with nothing
      // that may be the currency above it.
      const top = Math.max(...read.minor);
      let next: CheckoutTotal | undefined;
      try {
        next =
          cartOk && !converts && read.totals.includes(top) && Math.max(...read.loose) <= top
            ? requote(total, read)
            : undefined;
      } catch {
        // A part PayPal cannot write, or out of range: no re-quote, the page stays held.
        next = undefined;
      }
      this.#requote = next && next.minor !== total.minor ? next : undefined;
      const seen = sanitize(await rows(page), read.locale || "en", total.currency);
      this.held.push({
        locale: read.locale || null,
        amounts: read.minor.map(show),
        totals: read.totals.map(show),
        loose: read.shared.filter((a) => a.marks.length > 0).map((a) => show(a.value)),
        ...(read.unsure ? { unsure: read.unsure } : !judged.ok ? { unsure: judged.reason } : {}),
        ...(this.#cart ? { cart: cart ? show(cart.minor) : "unread" } : {}),
        ...(this.#requote ? { requote: show(this.#requote.minor) } : {}),
        ...(paypal ? { paypal: fundingLog(total, paypal.funding) } : {}),
        seen,
      });
      this.#refuse(
        read.unsure !== undefined
          ? `this page's amounts cannot be read for sure (${read.unsure}). Paying waits.`
          : !judged.ok && converts
            ? `this page does not show PayPal's order as the ${show(total.minor)} Keelson countersigned (${judged.reason}). Paying waits.`
            : !read.totals.includes(total.minor) && !this.#requote && cartOk
              ? `this page does not label ${show(total.minor)} as its total. Pay only where the total is the ${show(total.minor)} Keelson countersigned.`
              : this.#requote
                ? `this checkout's total is now ${show(this.#requote.minor)}, not the ${show(total.minor)} Keelson countersigned. Paying waits for Keelson to countersign the new total.`
                : `Keelson countersigned ${show(total.minor)}; this page or the store's cart does not show it as the total. Pay only for the countersigned cart.`,
      );
    }
    if (paypal) {
      this.paid = {
        charge: paypal.charge,
        funding: fundingLog(total, paypal.funding),
        ...(conversion ? { conversion } : {}),
      };
    }
  }

  /**
   * PayPal's order for the page and what PayPal charges the buyer for it, read from PayPal right
   * before the action, once the checkout has settled: refused unless the order charges exactly
   * `total`, is a payment, and pays the payee the mandate names, and unless PayPal's funding data
   * states what the Pay form pays with. An order whose breakdown adds tax or shipping to the
   * countersigned items is held with that total as its re-quote.
   */
  /**
   * Waits for PayPal's checkout to settle and returns the Pay form the action submits, read twice
   * alike; held while PayPal is still updating it.
   */
  async #settle(page: Page, action: PayAction): Promise<PayForm | undefined | false> {
    const target = "target" in action ? action.target : undefined;
    if (!target) return false;
    // PayPal refetches its funding data after a change; the form shows the old one until then.
    await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => {});
    const busy = await target
      .evaluate((node) => {
        const el = node.closest("button, input, [role=button]") ?? node;
        return (
          el.getAttribute("aria-busy") === "true" ||
          el.getAttribute("aria-disabled") === "true" ||
          (el instanceof HTMLButtonElement && el.disabled)
        );
      })
      .catch(() => true);
    const form = await readPayForm(target);
    await page.waitForTimeout(REREAD_MS);
    const again = await readPayForm(target);
    if (busy || JSON.stringify(form) !== JSON.stringify(again)) {
      this.#refuse(
        "PayPal's checkout is still updating. Read the page again, then repeat the action.",
      );
    }
    return form;
  }

  async #order(
    page: Page,
    form: PayForm | undefined | false,
    total: CheckoutTotal,
    show: (m: number) => string,
    read: PageReading,
  ): Promise<{ charge: PayPalCharge; funding: Funding }> {
    let partial: Partial<Funding> | undefined;
    const fail = async (reason: string): Promise<never> => {
      this.held.push({
        locale: read.locale || null,
        amounts: read.minor.map(show),
        totals: read.totals.map(show),
        loose: read.shared.filter((a) => a.marks.length > 0).map((a) => show(a.value)),
        unsure: reason,
        ...(this.#requote ? { requote: show(this.#requote.minor) } : {}),
        ...(partial ? { paypal: fundingLog(total, partial) } : {}),
        seen: sanitize(await rows(page), read.locale || "en", total.currency),
      });
      this.#refuse(reason);
    };
    const token = orderToken(page.url());
    if (!token || form === false) {
      return fail("PayPal's order for this page could not be read. Paying waits.");
    }
    const charge = await readCharge(page);
    if (!charge) return fail("PayPal's order for this page could not be read. Paying waits.");
    const problem = chargeProblem(charge, total);
    if (problem) {
      const next = requoteOf(charge, total);
      this.#requote = next;
      return fail(
        next
          ? `this checkout's total is now ${show(next.minor)}, not the ${show(total.minor)} Keelson countersigned. Paying waits for Keelson to countersign the new total.`
          : `${problem}, not the ${show(total.minor)} Keelson countersigned. Paying waits.`,
      );
    }
    if (!INTENTS.has(charge.intent))
      await fail(`PayPal's order is not a payment (${charge.intent}).`);
    if (this.#payee !== undefined && charge.payee !== this.#payee) {
      await fail("PayPal's order pays another merchant than the mandate names. Paying waits.");
    }
    const funding = await readFunding(page, token, form, charge);
    if (!funding.ok) {
      partial = funding.funding;
      return fail(`${funding.reason}. Paying waits.`);
    }
    return { charge, funding: funding.funding };
  }

  /**
   * PayPal's conversion of the total, checked against the reference rate bound into the
   * countersign's evidence; why not, without a current reference or over the mandate's spread.
   */
  #conversion(total: CheckoutTotal, shown: ShownConversion): Conversion | string {
    const ref = this.#reference;
    const rate = ref?.base === total.currency ? ref.rates[shown.currency] : undefined;
    if (!ref || rate === undefined || Date.now() - Date.parse(ref.as_of) > REFERENCE_MAX_AGE_MS) {
      return `PayPal converts this total to ${shown.currency}, and Keelson has no current reference rate from ${total.currency} to ${shown.currency} to check PayPal's rate against. Paying waits.`;
    }
    const spread = spreadBps(shown.rate, rate);
    if (spread > this.#maxSpreadBps) {
      return `PayPal charges ${shown.buyer} ${shown.currency}, ${shown.rate} ${shown.currency} per ${total.currency}, ${spread} basis points from the reference rate of ${rate}, over the mandate's cap of ${this.#maxSpreadBps}. Paying waits.`;
    }
    return {
      v: "keelson.conversion/1",
      merchant: {
        currency: total.currency,
        value: decimalText(total.minor, minorDigits(total.currency)),
      },
      buyer: { currency: shown.currency, value: shown.buyer },
      rate: shown.rate,
      reference: { rate, provider: ref.provider, source: ref.source, as_of: ref.as_of },
      spread_bps: spread,
      max_spread_bps: this.#maxSpreadBps,
      locale: shown.locale,
    };
  }
}
