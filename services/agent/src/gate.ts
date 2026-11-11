import { ToolError } from "@anthropic-ai/sdk/helpers/beta/toolsets";
import type { Locator, Page } from "playwright";
import { type Money, minorDigits, pageLocales, readPage } from "./amounts.ts";

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
 * pay control anywhere. Once Keelson allowed the cart, those actions go through only on a page
 * whose largest amount in the cart's currency, read in the page's own locale, is its total, and
 * only while the store's own cart (when it serves one) is that total too. Whatever the gate cannot
 * read, it holds. On a checkout page, clicks by coordinate, keys and typed text
 * are refused always, as are saving a payment method, installments and credit. Checkout hosts
 * are written like the browser's allowlist: exact, or `*.example.com` for its subdomains.
 */
export class PayGate {
  readonly #checkoutHosts: readonly string[];
  readonly #cart: (() => Promise<Money | undefined>) | undefined;
  #total: Money | undefined;
  /** Actions refused so far. */
  refused = 0;
  /**
   * Each page where a pay action was held for its total: the locale it was read in and the
   * amounts it showed in the cart's currency. Nothing else of the page.
   */
  readonly held: {
    locale: string | null;
    amounts: string[];
    unsure?: string;
    cart?: string;
  }[] = [];

  /**
   * `cart` reads the store's own cart (Shopify's `/cart.js`), the structured total a pay action
   * is checked against besides the page's text; undefined when it cannot be read.
   */
  constructor(o: { checkoutHosts: readonly string[]; cart?: () => Promise<Money | undefined> }) {
    this.#checkoutHosts = o.checkoutHosts;
    this.#cart = o.cart;
  }

  /** Opens the gate for the countersigned total. */
  allow(total: Money): void {
    this.#total = total;
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
    const { lang, text } = await page
      .evaluate(() => ({
        lang: document.documentElement.lang,
        // biome-ignore lint/performance/useDomNodeTextContent: the amounts as the buyer sees them on the page.
        text: document.body.innerText,
      }))
      .catch(() => ({ lang: "", text: "" }));
    const read = readPage(text, pageLocales(lang, page.url()), total.currency);
    const cart = this.#cart ? await this.#cart().catch(() => undefined) : undefined;
    const digits = minorDigits(total.currency);
    const show = (m: number) => `${total.currency} ${(m / 10 ** digits).toFixed(digits)}`;
    const cartOk = !this.#cart || (cart?.currency === total.currency && cart.minor === total.minor);
    if (
      read.unsure !== undefined ||
      !read.minor.includes(total.minor) ||
      Math.max(...read.minor) > total.minor ||
      !cartOk
    ) {
      this.held.push({
        locale: read.locale || null,
        amounts: read.minor.map(show),
        ...(read.unsure ? { unsure: read.unsure } : {}),
        ...(this.#cart ? { cart: cart ? show(cart.minor) : "unread" } : {}),
      });
      this.#refuse(
        read.unsure !== undefined
          ? `this page's amounts cannot be read for sure (${read.unsure}). Paying waits.`
          : `Keelson countersigned ${show(total.minor)}; this page or the store's cart does not show it as the total. Pay only for the countersigned cart.`,
      );
    }
  }
}
