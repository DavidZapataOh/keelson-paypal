import { ToolError } from "@anthropic-ai/sdk/helpers/beta/toolsets";
import {
  type CheckoutTotal,
  type Conversion,
  convertsTo,
  DEFAULT_MAX_SPREAD_BPS,
  type FxReference,
  spreadBps,
} from "@keelson/core";
import type { Locator, Page } from "playwright";
import {
  decimalText,
  inverseOf,
  judge,
  judgeQuoted,
  type Money,
  minorDigits,
  type PageReading,
  pageLocales,
  type Quote,
  readPage,
  type ShownConversion,
  showsQuote,
} from "./amounts.ts";
import { rows, type Seen, sanitize } from "./capture.ts";
import {
  agrees,
  chargeProblem,
  type KnownConversion,
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
/** A store's checkout, on its own host: Shopify's `/checkouts/…`, and the usual `/checkout`. */
const CHECKOUT_PATH = /\/checkouts?(?:\/|$)/;

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
 * On PayPal, the order itself decides: the page asks PayPal for its checkout session as PayPal's
 * own buttons do, and pays only an order whose total is exactly the countersigned value and
 * currency, whose intent is a payment and whose only payee is the one the mandate names, when it
 * names one. The page's text is then a cross-check: it must show no larger charge. When it shows
 * the total converted to the buyer's currency, the converted total must be the countersigned one
 * at the one rate the page writes, and that rate within the mandate's spread of the reference
 * rate Keelson fetched when it countersigned. Where PayPal states only its rate per unit and the
 * page alone shows the converted total, that total for the order must be within the mandate's
 * spread of PayPal's rate, up to the digits PayPal shows of it.
 */
export class PayGate {
  readonly #checkoutHosts: readonly string[];
  readonly #convertHosts: readonly string[];
  readonly #cart: (() => Promise<Money | undefined>) | undefined;
  readonly #payee: string | undefined;
  readonly #maxSpreadBps: number;
  #total: CheckoutTotal | undefined;
  #reference: FxReference | undefined;
  /** The orders whose page was switched to English to read a conversion. */
  readonly #english = new Set<string>();
  /**
   * What the last pay action let through on PayPal paid: PayPal's order, and its conversion to the
   * buyer's currency when the page showed one.
   */
  paid: { charge: PayPalCharge; conversion?: Conversion } | undefined;
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
    unsure?: string;
    cart?: string;
    requote?: string;
    /** The conversions PayPal stated for the order's funding options, when it was held for them. */
    conversions?: string[];
    /** The rates per unit PayPal stated for them. */
    quotes?: string[];
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
    // Every frame's text: a total drawn inside a frame is on the page the buyer sees.
    const text = (
      await Promise.all(
        page
          .frames()
          // biome-ignore lint/performance/useDomNodeTextContent: the amounts as the buyer sees them on the page.
          .map((f) => f.evaluate(() => document.body?.innerText ?? "").catch(() => "")),
      )
    ).join("\n");
    const converts = PayGate.#matches(this.#convertHosts, URL.parse(page.url())?.hostname ?? "");
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
    let paypal: { charge: PayPalCharge; known?: KnownConversion; quote?: Quote } | undefined;
    if (converts) {
      paypal = await this.#order(page, total, show, read);
      // Without PayPal's own conversion, the page's text is read in English, where PayPal writes
      // each amount with its ISO code; once per order, through the page's own locale parameter.
      const token = orderToken(page.url()) as string;
      const shows = Object.keys(read.rates).length > 0 || read.conversions.length > 0;
      if (
        !paypal.known &&
        !paypal.quote &&
        shows &&
        !/^en\b/.test(read.locale) &&
        !this.#english.has(token)
      ) {
        this.#english.add(token);
        const url = new URL(page.url());
        url.searchParams.set("locale.x", "en_US");
        await page.goto(url.href, { waitUntil: "load" }).catch(() => {});
        this.#refuse(
          "Keelson switched PayPal's page to English to read its currency conversion. Read the page again, then repeat the action.",
        );
      }
    }
    const known = paypal?.known;
    // PayPal's rate per unit, with the converted total only on the page: within the mandate's
    // spread of PayPal's rate.
    const judged = paypal?.quote
      ? judgeQuoted(read, total.minor, total.currency, paypal.quote, this.#maxSpreadBps)
      : judge(
          read,
          total.minor,
          total.currency,
          converts,
          !converts,
          known && { currency: known.currency, rate: known.rate },
        );
    // PayPal's own conversion when it states one; else the one the page writes.
    const shown = known
      ? {
          currency: known.currency,
          rate: known.rate,
          buyer: known.buyer,
          locale: read.locale || "en",
        }
      : judged.ok
        ? judged.conversion
        : undefined;
    const conversion = judged.ok && shown ? this.#conversion(total, shown) : undefined;
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
        ...(read.unsure ? { unsure: read.unsure } : !judged.ok ? { unsure: judged.reason } : {}),
        ...(this.#cart ? { cart: cart ? show(cart.minor) : "unread" } : {}),
        ...(this.#requote ? { requote: show(this.#requote.minor) } : {}),
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
    if (paypal) this.paid = { charge: paypal.charge, ...(conversion ? { conversion } : {}) };
  }

  /**
   * PayPal's order for the page, read from PayPal right before the action: refused unless it
   * charges exactly `total`, is a payment, and pays the payee the mandate names. An order whose
   * breakdown adds tax or shipping to the countersigned items is held with that total as its
   * re-quote. With it, PayPal's own conversion of the total to the buyer's funding currency, when
   * the page's GraphQL traffic stated exactly one.
   */
  async #order(
    page: Page,
    total: CheckoutTotal,
    show: (m: number) => string,
    read: PageReading,
  ): Promise<{ charge: PayPalCharge; known?: KnownConversion; quote?: Quote }> {
    const answer = await readCharge(page);
    const fail = async (reason: string): Promise<never> => {
      this.held.push({
        locale: read.locale || null,
        amounts: read.minor.map(show),
        totals: read.totals.map(show),
        unsure: reason,
        ...(this.#requote ? { requote: show(this.#requote.minor) } : {}),
        ...(answer?.conversions.length
          ? {
              conversions: answer.conversions.map(
                (c) =>
                  `${c.from.currency} ${c.from.value} = ${c.currency} ${c.buyer} at ${c.inverse ? `1/${c.inverse}` : c.rate}`,
              ),
            }
          : {}),
        ...(answer?.quotes.length
          ? {
              quotes: answer.quotes.map((q) =>
                q.inverse
                  ? `${q.currency} 1 = ${total.currency} ${q.rate}`
                  : `${total.currency} 1 = ${q.currency} ${q.rate}`,
              ),
            }
          : {}),
        seen: sanitize(await rows(page), read.locale || "en", total.currency),
      });
      this.#refuse(reason);
    };
    if (!answer) return fail("PayPal's order for this page could not be read. Paying waits.");
    const { charge, conversions, quotes } = answer;
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
    const options = [
      ...new Map(
        conversions.map((c) => [
          `${c.from.currency}|${c.from.value}|${c.currency}|${c.buyer}|${c.rate}`,
          c,
        ]),
      ).values(),
    ];
    if (options.some((c) => c.from.currency !== charge.currency || c.from.value !== charge.value)) {
      await fail("PayPal converts another amount than its order's total. Paying waits.");
    }
    // Stated from the buyer's currency, PayPal's own rate must give its two amounts.
    if (
      options.some((c) =>
        c.inverse !== undefined
          ? !agrees(c.buyer, c.inverse, charge.value)
          : !convertsTo(charge.value, c.rate, c.buyer),
      )
    ) {
      await fail("PayPal's conversion of the order does not add up. Paying waits.");
    }
    // Whichever funding option the buyer pays with, its conversion is within the mandate's spread.
    for (const c of options) {
      this.#conversion(total, { ...c, locale: read.locale || "en" });
    }
    const [only, ...more] = options;
    if (!only) {
      const rates = [
        ...new Map(quotes.map((q) => [`${q.currency}|${Number(q.rate)}|${q.inverse}`, q])).values(),
      ];
      const [one, ...others] = rates;
      if (!one) return { charge };
      if (others.length === 0) return { charge, quote: one };
      // Several: the page must show which one the buyer pays with, by its rate line.
      const lined = rates.filter(
        (q) =>
          (read.rates[q.currency] !== undefined || read.inverse[q.currency] !== undefined) &&
          showsQuote(read, q),
      );
      if (lined.length !== 1) {
        await fail(
          "PayPal states several rates and the page does not show which one it charges. Paying waits.",
        );
      }
      return { charge, quote: lined[0] as Quote };
    }
    if (more.length === 0) return { charge, known: only };
    // Several: the page must show which one the buyer pays with, by its rate.
    const shown = options.filter(
      (c) =>
        Number(read.rates[c.currency]) === Number(c.rate) ||
        (read.inverse[c.currency] !== undefined &&
          inverseOf(c.rate, read.inverse[c.currency] as string)),
    );
    if (shown.length !== 1) {
      await fail(
        "PayPal states several conversions and the page does not show which one it charges. Paying waits.",
      );
    }
    return { charge, known: shown[0] as KnownConversion };
  }

  /**
   * The conversion PayPal shows, checked against the reference rate bound into the countersign's
   * evidence: refused without a current reference, or over the mandate's spread.
   */
  #conversion(total: CheckoutTotal, shown: ShownConversion): Conversion {
    const ref = this.#reference;
    const rate = ref?.base === total.currency ? ref.rates[shown.currency] : undefined;
    if (!ref || rate === undefined || Date.now() - Date.parse(ref.as_of) > REFERENCE_MAX_AGE_MS) {
      this.#refuse(
        `PayPal converts this total to ${shown.currency}, and Keelson has no current reference rate from ${total.currency} to ${shown.currency} to check PayPal's rate against. Paying waits.`,
      );
    }
    const spread = spreadBps(shown.rate, rate);
    if (spread > this.#maxSpreadBps) {
      this.#refuse(
        `PayPal's rate of ${shown.rate} ${shown.currency} per ${total.currency} is ${spread} basis points from the reference rate of ${rate}, over the mandate's cap of ${this.#maxSpreadBps}. Paying waits.`,
      );
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
