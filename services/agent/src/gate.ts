import { ToolError } from "@anthropic-ai/sdk/helpers/beta/toolsets";
import type { Locator, Page } from "playwright";

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
 * whose largest amount is its total. On a checkout page, clicks by coordinate, keys and typed text
 * are refused always, as are saving a payment method, installments and credit. Checkout hosts
 * are written like the browser's allowlist: exact, or `*.example.com` for its subdomains.
 */
export class PayGate {
  readonly #checkoutHosts: readonly string[];
  #total: { minor: number; currency: string } | undefined;
  /** Actions refused so far. */
  refused = 0;
  /** The amounts read on each page where a pay action was held for its total: nothing else of it. */
  readonly held: string[][] = [];

  constructor(o: { checkoutHosts: readonly string[] }) {
    this.#checkoutHosts = o.checkoutHosts;
  }

  /** Opens the gate for the countersigned total, in minor units. */
  allow(total: { minor: number; currency: string }): void {
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
    const shown = await page
      .locator("body")
      // biome-ignore lint/performance/useDomNodeTextContent: the amounts as the buyer sees them on the page.
      .innerText()
      .catch(() => "");
    const amounts = pageAmounts(shown);
    const same = amounts.filter((a) => a.currency === total.currency).map((a) => a.minor);
    if (!same.includes(total.minor) || Math.max(...same) > total.minor) {
      this.held.push(amounts.map((a) => `${a.currency} ${(a.minor / 100).toFixed(2)}`));
      this.#refuse(
        `Keelson countersigned a total of ${total.currency} ${(total.minor / 100).toFixed(2)}, and this page does not show it as its largest amount. Pay only for the countersigned cart.`,
      );
    }
  }
}

/** Currency marks as stores and PayPal write them, and the ISO 4217 code each one means. */
const MARKS: Record<string, string> = {
  US$: "USD",
  USD: "USD",
  $: "USD",
  "€": "EUR",
  EUR: "EUR",
  "£": "GBP",
  GBP: "GBP",
};
const MARK = "US\\$|USD|EUR|GBP|\\$|€|£";
const NUMBER = "\\d{1,3}(?:[., ]\\d{3})+(?:[.,]\\d{2})?|\\d+(?:[.,]\\d{2})?";
const AMOUNT = new RegExp(
  `(${MARK}) ?(${NUMBER})(?![\\d])|(?<![\\d.,])(${NUMBER}) ?(${MARK})`,
  "g",
);

/** Minor units of a number written with `.` or `,` for decimals and either one, or a space, for thousands. */
function minorOf(text: string): number {
  const cents = /[.,](\d{2})$/.exec(text);
  const whole = (cents ? text.slice(0, -3) : text).replace(/[., ]/g, "");
  return Number(whole) * 100 + (cents ? Number(cents[1]) : 0);
}

/**
 * Every amount the text writes with a currency mark: `$2.95`, `US$2,95`, `2,95 US$`, `$2.95 USD`,
 * `1.234,56 €`, with any kind of space. A number without a mark is not an amount.
 */
export function pageAmounts(text: string): { currency: string; minor: number }[] {
  const flat = text.replace(/[\u00a0\u202f\u2009]/g, " ");
  return [...flat.matchAll(AMOUNT)].map((m) => ({
    currency: MARKS[(m[1] ?? m[4]) as string] as string,
    minor: minorOf((m[2] ?? m[3]) as string),
  }));
}
