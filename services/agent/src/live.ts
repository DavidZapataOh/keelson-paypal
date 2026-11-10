import type Anthropic from "@anthropic-ai/sdk";
import { type Cart, type Json, jcs, sha256, toHex } from "@keelson/core";
import type { SealedItem } from "@keelson/evidence";
import type { Capture } from "@keelson/evidence/capture";
import type { BrowserContext, Page } from "playwright";
import type { ProposedCart, Step, Usage } from "./agent.ts";
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

/**
 * Prices a proposed cart from the Shopify store's own public product JSON: the variant the line
 * names (or the product's only one), its SKU and price from `/products/<handle>.js`, and the
 * currency from the same variant's offer in `/products/<handle>.oembed`. Nothing the agent wrote
 * but product pages, variants and quantities reaches the cart.
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
    if (Math.round(offer.price * 100) !== variant.price) {
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
      unit_minor: variant.price,
    });
  }
  const cart: Cart = {
    merchant: store.merchant,
    currency: currency as string,
    lines,
    return_days: store.returnDays,
    returns_free: store.returnsFree,
  };
  const minor = lines.reduce((sum, l) => sum + l.qty * l.unit_minor, 0);
  return {
    cart,
    total: { currency: cart.currency, minor, display: (minor / 100).toFixed(2) },
    products,
  };
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
    "End the checkout. `paid` once the store shows its order confirmation; `blocked` when Keelson held a payment action; `stopped` when the checkout asks for anything you must not give or cannot be completed.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "note"],
    properties: {
      status: { type: "string", enum: ["paid", "blocked", "stopped"] },
      note: { type: "string" },
    },
  },
};

const CHECKOUT_SYSTEM = `You complete the checkout of a cart a shopping agent already chose, in the buyer's browser. Buy exactly the cart you are given on the store: put it in the store's cart, go to the store's checkout and pay with PayPal. The buyer's PayPal account is already signed in in this browser. Never type passwords, card numbers, codes or personal details, never add anything to the cart, never change the quantity, and decline every offer to save PayPal, a card or the buyer's information, to pay in installments or to take credit. Keelson holds every action that pays until it has countersigned this cart: if an action is blocked, do not look for another way to pay; call finish with blocked. When the store shows the order confirmation, call finish with paid.`;

const MODEL = "claude-sonnet-5-5";
const PRICE = [2, 10, 0.2, 2.5] as const;
const MAX_TURNS = 30;

export interface CheckoutRun {
  outcome: "paid" | "blocked" | "stopped" | "turns-exhausted";
  note: string;
  steps: Step[];
  usage: Usage;
  ms: number;
}

/** A URL as the run's log shows it: no query or fragment, which can carry checkout tokens. */
export function bare(url: string): string {
  const u = URL.parse(url);
  return u ? `${u.origin}${u.pathname}` : "";
}

/**
 * Drives the store's checkout for the countersigned cart with the browser toolset, on a driver
 * whose every payment action waits on `gate`. Returns once the model calls `finish`.
 */
export async function runCheckout(o: {
  client: Anthropic;
  context: BrowserContext;
  page: Page;
  hosts: readonly string[];
  gate: PayGate;
  quote: Quote;
  proposal: ProposedCart;
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
  const end = (outcome: CheckoutRun["outcome"], note: string): CheckoutRun => {
    step({ kind: "end", detail: outcome });
    return { outcome, note, steps, usage, ms: Math.round(performance.now() - started) };
  };
  const cart = o.proposal.lines.map((l, i) => ({
    product_url: l.product_url,
    variant: l.size,
    qty: l.qty,
    unit: ((o.quote.cart.lines[i]?.unit_minor ?? 0) / 100).toFixed(2),
  }));
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: `The cart: ${JSON.stringify(cart)}. Its total before any tax is ${o.quote.total.display} ${o.quote.total.currency}. Check it out with PayPal.`,
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
      if (response.stop_reason === "refusal") return end("stopped", "refused");
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
          const { status, note } = call.input as {
            status: "paid" | "blocked" | "stopped";
            note: string;
          };
          return end(status, note);
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
      messages.push({ role: "user", content: results });
    }
    return end("turns-exhausted", "");
  } finally {
    await browser.close();
  }
}

const TRANSACTION = /^[0-9A-Z]{17}$/;

/**
 * The PayPal transaction id of the payment just made: from the store's confirmation page when it
 * shows one, else from the newest entry of the buyer's PayPal activity that names `merchant` and
 * `total`, read in a tab
 * of its own that nothing records. Only the id leaves the page.
 */
export async function paypalTransactionId(
  context: BrowserContext,
  confirmation: Page,
  total: string,
  merchant: string,
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
    await tab.goto("https://www.paypal.com/myaccount/activities/", { waitUntil: "load" });
    const link = tab
      .locator('a[href*="/activit"]')
      .filter({ hasText: total })
      .filter({ hasText: merchant })
      .first();
    await link.waitFor({ timeout: 15_000 });
    const href = (await link.getAttribute("href")) ?? "";
    const id = /\/([0-9A-Z]{17})(?:[/?#]|$)/.exec(href)?.[1];
    return id && TRANSACTION.test(id) ? id : undefined;
  } catch {
    return undefined;
  } finally {
    await tab.close();
  }
}
