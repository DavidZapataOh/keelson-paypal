import { ToolError } from "@anthropic-ai/sdk/helpers/beta/toolsets";
import type { CheckoutTotal } from "@keelson/core";
import type { Locator, Page } from "playwright";
import { charges, type Money, minorDigits, pageLocales, readPage } from "./amounts.ts";
import { rows, type Seen, sanitize } from "./capture.ts";
import { requote } from "./requote.ts";

/** Names of the controls that commit a payment, on a store's checkout or on PayPal. */
const PAY =
  /\b(pay(?: now| with paypal| \$?[\d.,]+)?|complete (?:purchase|order|payment)|place (?:your )?order|submit order|buy now|agree (?:and|&) (?:pay|continue)|continue to review(?: order)?|confirm (?:and|&) pay)\b/i;
/** Offers the buyer never takes: saving a payment method, installments or credit. */
const NEVER =
  /\b(save (?:paypal|my|your|card|this|payment)|for (?:future|faster)|remember (?:me|this)|pay (?:in \d|later|monthly|over time)|paypal credit|installments?)\b/i;
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
 */
export class PayGate {
  readonly #checkoutHosts: readonly string[];
  readonly #cart: (() => Promise<Money | undefined>) | undefined;
  #total: CheckoutTotal | undefined;
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
    seen: Seen[];
  }[] = [];

  /**
   * `cart` reads what the store's own cart (Shopify's `/cart.js`) charges for its items, after
   * discounts and before tax and shipping: the structured amount a pay action is checked against
   * besides the page's text; undefined when it cannot be read.
   */
  constructor(o: { checkoutHosts: readonly string[]; cart?: () => Promise<Money | undefined> }) {
    this.#checkoutHosts = o.checkoutHosts;
    this.#cart = o.cart;
  }

  /** Opens the gate for the countersigned checkout total, and only for it. */
  allow(total: CheckoutTotal): void {
    this.#total = total;
    this.#requote = undefined;
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

  #onCheckout(page: Page): boolean {
    const url = URL.parse(page.url());
    if (!url) return false;
    const host = url.hostname;
    return (
      this.#checkoutHosts.some((h) =>
        h.startsWith("*.") ? host.endsWith(h.slice(1)) : h === host,
      ) || CHECKOUT_PATH.test(url.pathname)
    );
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
    const read = readPage(text, pageLocales(lang, page.url()), total.currency);
    const cart = this.#cart ? await this.#cart().catch(() => undefined) : undefined;
    const digits = minorDigits(total.currency);
    const show = (m: number) => `${total.currency} ${(m / 10 ** digits).toFixed(digits)}`;
    const cartOk =
      !this.#cart ||
      (cart?.currency === total.currency && cart.minor === total.items - total.discount);
    if (!charges(read, total.minor, total.currency) || !cartOk) {
      // A re-quote is the page's largest amount, which it must label its total, with nothing
      // that may be the currency above it.
      const top = Math.max(...read.minor);
      let next: CheckoutTotal | undefined;
      try {
        next =
          cartOk && read.totals.includes(top) && Math.max(...read.loose) <= top
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
        ...(read.unsure ? { unsure: read.unsure } : {}),
        ...(this.#cart ? { cart: cart ? show(cart.minor) : "unread" } : {}),
        ...(this.#requote ? { requote: show(this.#requote.minor) } : {}),
        seen,
      });
      this.#refuse(
        read.unsure !== undefined
          ? `this page's amounts cannot be read for sure (${read.unsure}). Paying waits.`
          : !read.totals.includes(total.minor) && !this.#requote && cartOk
            ? `this page does not label ${show(total.minor)} as its total. Pay only where the total is the ${show(total.minor)} Keelson countersigned.`
            : this.#requote
              ? `this checkout's total is now ${show(this.#requote.minor)}, not the ${show(total.minor)} Keelson countersigned. Paying waits for Keelson to countersign the new total.`
              : `Keelson countersigned ${show(total.minor)}; this page or the store's cart does not show it as the total. Pay only for the countersigned cart.`,
      );
    }
  }
}
