import type Anthropic from "@anthropic-ai/sdk";
import {
  type Cart,
  type CheckoutTotal,
  checkoutTotal,
  type FxReference,
  type Json,
  jcs,
  sha256,
  toHex,
} from "@keelson/core";
import type { SealedItem } from "@keelson/evidence";
import type { Capture } from "@keelson/evidence/capture";
import type { BrowserContext, Page } from "playwright";
import type { ProposedCart, Step, Usage } from "./agent.ts";
import { type Money, minorDigits } from "./amounts.ts";
import { CheckoutError, type Keelson, type Quote } from "./checkout.ts";
import { StoreBrowser } from "./driver.ts";
import type { PayGate } from "./gate.ts";
import { datamark } from "./spotlight.ts";

/** A real store that accepts PayPal, and how the agent's cart lines on it are labeled. */
export interface LiveStore {
  /** The store's origin, `https://shop.example`. */
  origin: string;
  /** The merchant id the mandate allows. */
  merchant: string;
  /** The Google Product Taxonomy category of what the mandate buys there, `gpt:<id>`. */
  category: string;
  returnDays: number;
  returnsFree: boolean;
  /** Every host the store's pages, its checkout and PayPal load, in KERNEL's allowlist syntax. */
  hosts: readonly string[];
  /** Hosts whose every page is a checkout page. */
  checkoutHosts: readonly string[];
  /** The store's PayPal merchant id, as PayPal's orders name their payee. */
  paypalMerchantId: string;
}

/** Shopify's `/products/<handle>.js`, the fields the quote reads. */
interface ShopifyProduct {
  id: number;
  handle: string;
  title: string;
  variants: { id: number; sku: string | null; title: string; price: number; available: boolean }[];
}

/** Shopify's `/products/<handle>.oembed`: one offer per variant, with the store's currency. */
interface ShopifyOembed {
  offers: { offer_id: number; price: number; currency_code: string; in_stock: boolean }[];
}

const UA = "Keelson/1.0 (+https://keelson.finance)";

async function json<T>(url: string, what: string): Promise<T> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!res.ok) throw new CheckoutError(`${what}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** The product page path on a Shopify store, `/products/<handle>`, or undefined. */
const handleOf = (url: URL) => /^\/products\/([a-z0-9][a-z0-9-]{0,254})$/.exec(url.pathname)?.[1];

/** An amount of minor units as a plain decimal in its currency's own minor units: `2.95`, `1500`. */
export function decimal(currency: string, minor: number): string {
  const digits = minorDigits(currency);
  return (minor / 10 ** digits).toFixed(digits);
}

/**
 * Prices a proposed cart from the Shopify store's own public product JSON: the variant the line
 * names (or the product's only one), its SKU and price from `/products/<handle>.js`, and the
 * currency from the same variant's offer in `/products/<handle>.oembed`. Nothing the agent wrote
 * but product pages, variants and quantities reaches the cart. The quote's total is the items
 * alone: Shopify publishes no tax or shipping before the checkout knows the buyer's address, so
 * a checkout that adds them is re-quoted from the page the pay action waits on.
 */
export async function quoteShopify(store: LiveStore, proposal: ProposedCart): Promise<Quote> {
  const lines: Cart["lines"] = [];
  const products: unknown[] = [];
  let currency: string | undefined;
  for (const line of proposal.lines) {
    const url = URL.parse(line.product_url, store.origin);
    const handle = url && url.origin === store.origin ? handleOf(url) : undefined;
    if (!url || !handle)
      throw new CheckoutError("a proposed line is not a product page of the store");
    const base = `${store.origin}/products/${handle}`;
    const [product, oembed] = await Promise.all([
      json<ShopifyProduct>(`${base}.js`, "product"),
      json<ShopifyOembed>(`${base}.oembed`, "offers"),
    ]);
    const variant =
      product.variants.length === 1
        ? product.variants[0]
        : product.variants.find((v) => v.title === line.size);
    const offer = oembed.offers.find((o) => o.offer_id === variant?.id);
    if (!variant || !offer) throw new CheckoutError("the proposed variant is not on the store");
    if (!variant.available || !offer.in_stock) {
      throw new CheckoutError("the proposed variant is not available");
    }
    // Shopify's `.js` writes hundredths of the currency's unit; the cart counts its minor units.
    const digits = minorDigits(offer.currency_code);
    const unit = (variant.price * 10 ** digits) / 100;
    if (!Number.isInteger(unit) || Math.round(offer.price * 10 ** digits) !== unit) {
      throw new CheckoutError("the store's product endpoints disagree on the price");
    }
    if (currency !== undefined && currency !== offer.currency_code) {
      throw new CheckoutError("the lines are in different currencies");
    }
    currency = offer.currency_code;
    products.push(product);
    lines.push({
      sku: variant.sku || String(variant.id),
      size: null,
      color: null,
      category: store.category,
      qty: line.qty,
      unit_minor: unit,
    });
  }
  const cart: Cart = {
    merchant: store.merchant,
    currency: currency as string,
    lines,
    return_days: store.returnDays,
    returns_free: store.returnsFree,
  };
  const items = lines.reduce((sum, l) => sum + l.qty * l.unit_minor, 0);
  return { cart, total: checkoutTotal(cart.currency, { items }), products };
}

const post = async (keelson: Keelson, path: string, headers: HeadersInit, body: unknown) => {
  const res = await keelson.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const sealed = (type: SealedItem["type"], bytes: Uint8Array, salt?: Uint8Array): SealedItem => ({
  type,
  mediaType: "application/json",
  bytes,
  salt: salt ?? crypto.getRandomValues(new Uint8Array(32)),
});

/**
 * The two independent observations of the product a live purchase adds to its evidence: the
 * store's `.oembed` endpoint notarized with TLSNotary (`tlsn.web_fact`) and Channel3's own reading
 * of the product page (`channel3.observation`). Either one that fails is left out and reported in
 * `skipped`; neither ever blocks the countersign.
 */
export function liveObservations(o: {
  keelson: Keelson;
  headers: HeadersInit;
  mandateId: string;
  productUrl: string;
  quote: Quote;
  skipped: string[];
}): (capture: Capture) => Promise<SealedItem[]> {
  return async (capture) => {
    const line = o.quote.cart.lines[0] as Cart["lines"][number];
    const product = o.quote.products[0] as ShopifyProduct;
    const variant = product.variants.find((v) => (v.sku || String(v.id)) === line.sku);
    const productItem = capture.items.find((i) => i.type === "api.product");
    const [fact, observed] = await Promise.all([
      post(o.keelson, "/v1/observations/web-fact", o.headers, {
        url: `${o.productUrl}.oembed`,
        anchor: `"offer_id":${variant?.id}`,
      }),
      productItem
        ? post(o.keelson, "/v1/observations/channel3", o.headers, {
            mandateId: o.mandateId,
            url: o.productUrl,
            agentView: {
              contentHash: toHex(sha256(productItem.bytes)),
              priceMinor: String(line.unit_minor),
              currency: o.quote.cart.currency,
              available: true,
              selected: [],
            },
          })
        : Promise.resolve({ status: 0, body: {} as Record<string, unknown> }),
    ]);
    const items: SealedItem[] = [];
    if (fact.status === 201) {
      const { ms: _ms, webFact, ...rest } = fact.body;
      const doc = { url: `${o.productUrl}.oembed`, ...(webFact as object), ...rest };
      items.push(sealed("tlsn.web_fact", new TextEncoder().encode(jcs(doc as Json))));
    } else {
      o.skipped.push(`web-fact: HTTP ${fact.status} ${String(fact.body.type ?? "")}`);
    }
    if (observed.status === 201) {
      const item = observed.body.item as { salt: string; bytes: string };
      items.push(
        sealed(
          "channel3.observation",
          Uint8Array.from(Buffer.from(item.bytes, "base64")),
          Uint8Array.from(Buffer.from(item.salt, "base64")),
        ),
      );
    } else {
      o.skipped.push(`channel3: HTTP ${observed.status} ${String(observed.body.type ?? "")}`);
    }
    return items;
  };
}

const FINISH: Anthropic.Beta.BetaTool = {
  name: "finish",
  description:
    "End the checkout. `paid` once the store shows its order confirmation; `declined` when the store or PayPal says the payment was declined or could not be processed; `blocked` when Keelson held a payment action; `stopped` when the checkout asks for anything you must not give or cannot be completed. In `note`, say what the page shows, with no name, email, address or number of the buyer's.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "note"],
    properties: {
      status: { type: "string", enum: ["paid", "declined", "blocked", "stopped"] },
      note: { type: "string" },
    },
  },
};

const CHECKOUT_SYSTEM = `You complete the checkout of a cart a shopping agent already chose, in the buyer's browser. Buy exactly the cart you are given on the store: put it in the store's cart, go to the store's checkout and pay with PayPal. The buyer's PayPal account is already signed in in this browser. Never type passwords, card numbers, codes or personal details, never add anything to the cart, never change the quantity, and decline every offer to save PayPal, a card or the buyer's information, to pay in installments or to take credit. Keelson holds every action that pays until it has countersigned this cart: if an action is blocked, do not look for another way to pay; call finish with blocked. When the store shows the order confirmation, call finish with paid. If the store or PayPal says the payment was declined or could not be processed, do not try again or another way: call finish with declined.`;

const MODEL = "claude-sonnet-5-5";
const PRICE = [2, 10, 0.2, 2.5] as const;
const MAX_TURNS = 30;

/** How a checkout ended, as the model reports it and the page confirms it. */
type Outcome = "paid" | "declined" | "blocked" | "stopped";

export interface CheckoutRun {
  outcome: Outcome | "turns-exhausted";
  /** What the model said the page showed, with emails and long numbers removed. */
  note: string;
  /** The page where a checkout that did not pay ended, described without the buyer's details. */
  stop?: StopPage;
  /** The total the payment was allowed for: the quote's, or the last one re-quoted. */
  total: CheckoutTotal;
  steps: Step[];
  usage: Usage;
  ms: number;
}

/**
 * The page a checkout that did not pay ended on, as the log may keep it: whether it is a store's
 * order confirmation, the alerts it shows (emails and long numbers removed), the labels of its
 * required form fields and the names of its visible buttons. No field's value is read.
 *
 * @internal
 */
export interface StopPage {
  confirmation: boolean;
  alerts: string[];
  required: string[];
  buttons: string[];
}

/** A store's order confirmation: Shopify's `/thank-you` (or `/thank_you`) and `/orders/…`. */
const CONFIRMATION = /\/(?:thank[-_]you|orders\/)/;

/**
 * `text` with emails and runs of 4 or more digits removed, on one line, at most 300 characters.
 *
 * @internal
 */
export function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
    .replace(/\d(?:[\d\s().-]*\d){3,}/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/**
 * Describes the page a checkout that did not pay ended on, as {@link StopPage}.
 *
 * @internal
 */
export async function describeStop(page: Page): Promise<StopPage> {
  const shown = await page
    .evaluate(() => {
      const visible = (el: Element) => el.checkVisibility();
      const name = (el: Element) => (el as HTMLElement).innerText?.trim() ?? "";
      const label = (el: HTMLInputElement) =>
        (el.labels?.[0]?.innerText || el.getAttribute("aria-label") || el.placeholder || "").trim();
      return {
        alerts: [...document.querySelectorAll("[role=alert]")].filter(visible).map(name),
        required: [...document.querySelectorAll<HTMLInputElement>("input, select, textarea")]
          .filter(
            (el) =>
              el.type !== "hidden" &&
              visible(el) &&
              (el.required || el.getAttribute("aria-required") === "true"),
          )
          .map(label),
        buttons: [...document.querySelectorAll("button, [role=button], input[type=submit]")]
          .filter(visible)
          .map(
            (el) =>
              name(el) || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "",
          ),
      };
    })
    .catch(() => ({ alerts: [], required: [], buttons: [] }));
  const clean = (xs: string[]) => [...new Set(xs.map(scrub).filter(Boolean))];
  return {
    confirmation: CONFIRMATION.test(URL.parse(page.url())?.pathname ?? ""),
    alerts: clean(shown.alerts),
    required: clean(shown.required),
    buttons: clean(shown.buttons),
  };
}

/**
 * How a checkout ended: what the model reports, and a decline wherever the page shows one after
 * the gate let a payment through: an alert on the store's checkout and no order confirmation.
 *
 * @internal
 */
export function outcomeOf(
  reported: Outcome,
  page: Pick<StopPage, "confirmation" | "alerts">,
  paidThrough: boolean,
): Outcome {
  if (reported === "stopped" && paidThrough && !page.confirmation && page.alerts.length > 0) {
    return "declined";
  }
  return reported;
}

/** A URL as the run's log shows it: no query or fragment, which can carry checkout tokens. */
export function bare(url: string): string {
  const u = URL.parse(url);
  return u ? `${u.origin}${u.pathname}` : "";
}

/**
 * Drives the store's checkout for the countersigned cart with the browser toolset, on a driver
 * whose every payment action waits on `gate`. When the gate holds a page whose total adds tax or
 * shipping to the countersigned one, `requote` asks Keelson to countersign that total; the gate
 * opens for it only if Keelson allows it. Returns once the model calls `finish`.
 */
export async function runCheckout(o: {
  client: Anthropic;
  context: BrowserContext;
  page: Page;
  hosts: readonly string[];
  gate: PayGate;
  quote: Quote;
  proposal: ProposedCart;
  /**
   * Countersigns a re-quoted checkout total: whether Keelson allowed it, and the reference rates
   * its evidence binds.
   */
  requote?: (total: CheckoutTotal) => Promise<{ allowed: boolean; reference?: FxReference }>;
  onStep?: (step: Step) => void;
}): Promise<CheckoutRun> {
  const started = performance.now();
  const steps: Step[] = [];
  const step = (s: Omit<Step, "at">) => {
    const full = { at: Math.round(performance.now() - started), ...s };
    steps.push(full);
    o.onStep?.(full);
  };
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
  const mark = datamark();
  const browser = await StoreBrowser.attach(o.context, o.page, {
    hosts: o.hosts,
    mark: mark.mark,
    gate: o.gate,
  });
  let total = o.quote.total;
  const end = async (reported: CheckoutRun["outcome"], note: string): Promise<CheckoutRun> => {
    const stop = reported === "paid" ? undefined : await describeStop(browser.page);
    const outcome =
      stop && reported !== "turns-exhausted"
        ? outcomeOf(reported, stop, o.gate.paid !== undefined)
        : reported;
    step({ kind: "end", detail: outcome });
    return {
      outcome,
      note: scrub(note),
      ...(stop ? { stop } : {}),
      total,
      steps,
      usage,
      ms: Math.round(performance.now() - started),
    };
  };
  const show = (t: CheckoutTotal) => `${decimal(t.currency, t.minor)} ${t.currency}`;
  const cart = o.proposal.lines.map((l, i) => ({
    product_url: l.product_url,
    variant: l.size,
    qty: l.qty,
    unit: (
      (o.quote.cart.lines[i]?.unit_minor ?? 0) /
      10 ** minorDigits(o.quote.cart.currency)
    ).toFixed(minorDigits(o.quote.cart.currency)),
  }));
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: `The cart: ${JSON.stringify(cart)}. Its total before any tax or shipping is ${show(o.quote.total)}. Check it out with PayPal.`,
    },
  ];
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const t = performance.now();
      const response = await o.client.beta.messages.create({
        model: MODEL,
        max_tokens: 8_000,
        output_config: { effort: "medium" },
        cache_control: { type: "ephemeral" },
        system: [{ type: "text", text: `${CHECKOUT_SYSTEM}\n\n${mark.instructions}` }],
        tools: [browser.toJSON(), FINISH],
        messages,
      });
      const u = response.usage;
      usage.input += u.input_tokens;
      usage.output += u.output_tokens;
      usage.cacheRead += u.cache_read_input_tokens ?? 0;
      usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
      usage.usd +=
        (u.input_tokens * PRICE[0] +
          u.output_tokens * PRICE[1] +
          (u.cache_read_input_tokens ?? 0) * PRICE[2] +
          (u.cache_creation_input_tokens ?? 0) * PRICE[3]) /
        1e6;
      step({
        kind: "model",
        detail: response.stop_reason ?? "",
        ms: Math.round(performance.now() - t),
      });
      if (response.stop_reason === "refusal") return await end("stopped", "refused");
      messages.push({ role: "assistant", content: response.content });
      const calls = response.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
      );
      if (calls.length === 0) {
        messages.push({ role: "user", content: "Continue, or call finish." });
        continue;
      }
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const call of calls) {
        if (call.name === FINISH.name) {
          const { status, note } = call.input as { status: Outcome; note: string };
          return await end(status, note);
        }
        const tt = performance.now();
        const result = await browser.toolResult(call);
        const input = call.input as { url?: string };
        const detail = input.url ? { ...input, url: bare(input.url) } : input;
        step({
          kind: "tool",
          detail: `${call.name} ${JSON.stringify(detail)} on ${bare(browser.page.url())}${result.is_error ? " (error)" : ""}`,
          ms: Math.round(performance.now() - tt),
        });
        results.push(result);
      }
      const content: Anthropic.Beta.BetaContentBlockParam[] = [...results];
      const next = o.gate.takeRequote();
      if (next && o.requote) {
        const t = performance.now();
        const { allowed, reference } = await o.requote(next);
        step({
          kind: "requote",
          detail: `${show(next)} ${allowed ? "allowed" : "not allowed"}`,
          ms: Math.round(performance.now() - t),
        });
        if (allowed) {
          o.gate.allow(next, reference);
          total = next;
        }
        content.push({
          type: "text",
          text: allowed
            ? `Keelson countersigned the checkout's new total of ${show(next)}: items ${decimal(next.currency, next.items)}, tax ${decimal(next.currency, next.tax)}, shipping ${decimal(next.currency, next.shipping)}. Repeat the action that was held.`
            : `Keelson did not countersign the checkout's new total of ${show(next)}. Do not pay: call finish with blocked.`,
        });
      }
      messages.push({ role: "user", content });
    }
    return await end("turns-exhausted", "");
  } finally {
    await browser.close();
  }
}

const TRANSACTION = /^[0-9A-Z]{17}$/;
const DECIMAL = /^\d+(?:\.\d+)?$/;
/** Activity types that are the buyer paying a merchant. */
const PAYMENTS = new Set(["PAYMENT_SENT", "AUTHORIZATION"]);
/** How long before the pay click an entry may be dated, for clock skew between the two. */
const SKEW_MS = 120_000;
/** How many of the newest activity entries are opened. */
const NEWEST = 10;

/** The fields read from an entry's details in the buyer's PayPal activity. */
export interface ActivityEntry {
  transactionId: string;
  transactionTypeEnum: string;
  timeCreatedInISO: string;
  amount: { rawAmounts: { gross: { value: string; currencyCode: string } } };
}

/** What the payment just made charged, and when its pay click was let through, at the latest. */
export interface PaidOrder {
  currency: string;
  /** The order's total, a decimal string (`2.95`). */
  value: string;
  since: Date;
}

const sameDecimal = (a: string, b: string) =>
  DECIMAL.test(a) && DECIMAL.test(b) && Number(a) === Number(b);

/**
 * The id of the one activity entry that is a payment or authorization of exactly the order's
 * gross since its pay click; undefined when none is, or more than one.
 */
export function activityMatch(entries: readonly unknown[], order: PaidOrder): string | undefined {
  const ids = entries.flatMap((e) => {
    const x = e as Partial<ActivityEntry> | null;
    const gross = x?.amount?.rawAmounts?.gross;
    const at = Date.parse(x?.timeCreatedInISO ?? "");
    const ok =
      typeof x?.transactionId === "string" &&
      TRANSACTION.test(x.transactionId) &&
      PAYMENTS.has(x.transactionTypeEnum ?? "") &&
      gross?.currencyCode === order.currency &&
      sameDecimal(String(gross.value), order.value) &&
      at >= order.since.getTime() - SKEW_MS;
    return ok ? [x.transactionId as string] : [];
  });
  return ids.length === 1 ? ids[0] : undefined;
}

/**
 * The PayPal transaction id of the payment just made: from the store's confirmation page when it
 * shows one, else from the buyer's PayPal activity, in a tab of its own that nothing records. The
 * activity page lists entries by id; each entry's details, which the page itself fetches when one
 * is opened, state its type, time and gross, and the one {@link activityMatch} finds is taken.
 * Only the id leaves PayPal's pages.
 */
export async function paypalTransactionId(
  context: BrowserContext,
  confirmation: Page,
  order: PaidOrder,
  paypal = "https://www.paypal.com",
): Promise<string | undefined> {
  const shown = await confirmation
    .locator("body")
    // biome-ignore lint/performance/useDomNodeTextContent: the page as the buyer reads it.
    .innerText()
    .catch(() => "");
  const onPage = /transaction(?: id)?\W{0,20}([0-9A-Z]{17})\b/i.exec(shown)?.[1];
  if (onPage && TRANSACTION.test(onPage)) return onPage;
  const tab = await context.newPage();
  try {
    await tab.goto(`${paypal}/myaccount/activities/`, { waitUntil: "load" });
    const rows = tab.locator('[class*="js_transactionItem-"]');
    await rows.first().waitFor({ timeout: 15_000 });
    const ids = (await rows.evaluateAll((els) => els.map((e) => e.className)))
      .map((c) => /\bjs_transactionItem-([0-9A-Z]{17})\b/.exec(c)?.[1])
      .filter((id): id is string => id !== undefined)
      .slice(0, NEWEST);
    const entries = await tab.evaluate(
      (ids) =>
        Promise.all(
          ids.map((id) =>
            fetch(`/myaccount/activities/details/inline/${id}`, {
              credentials: "same-origin",
              headers: { accept: "application/json" },
            })
              .then((r) => (r.ok ? r.json() : undefined))
              .then((b) => b?.data)
              .catch(() => undefined),
          ),
        ),
      ids,
    );
    return activityMatch(entries, order);
  } catch {
    return undefined;
  } finally {
    await tab.close();
  }
}

/**
 * The store's own cart, as the browser's Shopify session holds it (`/cart.js`): the structured
 * total the pay-click gate checks besides the page's text. Shopify writes money in hundredths of
 * the currency's unit, whatever its minor units. Undefined when the cart cannot be read.
 */
export function shopifyCart(
  context: Pick<BrowserContext, "request">,
  origin: string,
): () => Promise<Money | undefined> {
  return async () => {
    const res = await context.request.get(`${origin}/cart.js`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok()) return undefined;
    const cart = (await res.json()) as { currency?: string; total_price?: number };
    if (typeof cart.currency !== "string" || !Number.isInteger(cart.total_price)) return undefined;
    const minor = ((cart.total_price as number) * 10 ** minorDigits(cart.currency)) / 100;
    return Number.isInteger(minor) ? { currency: cart.currency, minor } : undefined;
  };
}
