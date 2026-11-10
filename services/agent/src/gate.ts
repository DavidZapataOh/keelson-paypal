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
  | { kind: "enter" };

/**
 * Holds every action that could commit a payment until Keelson countersigned the cart: any action
 * on a checkout host (PayPal), a click on a pay control anywhere, and on a store's checkout page
 * any click by coordinate or the Enter key. Once Keelson allowed the cart, those actions go
 * through only on a page that shows its total. Saving a payment method, installments and credit
 * are refused always.
 */
export class PayGate {
  readonly #checkoutHosts: readonly string[];
  #total: string | undefined;
  /** Actions refused so far. */
  refused = 0;

  constructor(o: { checkoutHosts: readonly string[] }) {
    this.#checkoutHosts = o.checkoutHosts;
  }

  /** Opens the gate for the countersigned total, in minor units. */
  allow(total: { minor: number; currency: string }): void {
    this.#total = (total.minor / 100).toFixed(2);
  }

  get open(): boolean {
    return this.#total !== undefined;
  }

  /**
   * The control's name as the page labels it (its text, label, title and value), and whether it
   * is a box already checked, which acting on unchecks.
   */
  static async #control(target: Locator): Promise<{ name: string; checked: boolean }> {
    const read = await target
      .evaluate((el) => ({
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
      }))
      .catch(() => ({ name: "", checked: false }));
    return { name: read.name.replace(/\s+/g, " "), checked: read.checked };
  }

  /** Throws the tool error the model receives when `action` must wait or is never taken. */
  async check(page: Page, action: PayAction): Promise<void> {
    const { name, checked } =
      "target" in action ? await PayGate.#control(action.target) : { name: "", checked: false };
    if (NEVER.test(name) && !checked) {
      this.refused++;
      throw new ToolError(
        "blocked: the buyer never saves a payment method, pays in installments or takes credit.",
      );
    }
    const url = URL.parse(page.url());
    const pays =
      (url !== null && this.#checkoutHosts.includes(url.hostname)) ||
      (action.kind === "click"
        ? PAY.test(name)
        : action.kind !== "input" && url !== null && CHECKOUT_PATH.test(url.pathname));
    if (!pays) return;
    const total = this.#total;
    if (total === undefined) {
      this.refused++;
      throw new ToolError(
        "blocked: this action can pay, and Keelson has not countersigned the cart. Paying waits for its 2-of-2 countersignature; do not try another way to pay.",
      );
    }
    const shown = await page
      .locator("body")
      // biome-ignore lint/performance/useDomNodeTextContent: the total as the buyer sees it on the page.
      .innerText()
      .catch(() => "");
    if (!new RegExp(`(?<![\\d.])${total.replace(".", "\\.")}(?!\\d)`).test(shown)) {
      this.refused++;
      throw new ToolError(
        `blocked: Keelson countersigned a total of ${total}, and this page does not show it. Pay only for the countersigned cart.`,
      );
    }
  }
}
