import { type Cart, cartHash, toHex } from "@keelson/core";
import { type Capture, captureEvidence } from "@keelson/evidence/capture";
import { closeMandate } from "@keelson/mandate";
import { ulid } from "ulid";
import type { ProposedCart } from "./agent.ts";
import type { Session } from "./kernel.ts";

/** The store's answer to `POST /api/cart`: the cart as Keelson's engine hashes it. */
export interface Quote {
  cart: Cart;
  total: { currency: string; minor: number; display: string };
  /** The product JSON of each line, as the store's API serves it. */
  products: unknown[];
}

export class CheckoutError extends Error {}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new CheckoutError(`${what}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Prices a proposed cart from the store itself: each line's product is resolved from its page
 * URL on the store's origin, and the cart, prices included, is the store's answer. Nothing the
 * agent wrote but product pages, sizes and quantities reaches the cart.
 */
export async function quoteCart(storeOrigin: string, proposal: ProposedCart): Promise<Quote> {
  const origin = new URL(storeOrigin).origin;
  const lines: { handle: string; size: string; qty: number }[] = [];
  const products: unknown[] = [];
  for (const line of proposal.lines) {
    const url = URL.parse(line.product_url, origin);
    if (!url || url.origin !== origin) {
      throw new CheckoutError("a proposed product is not on the store");
    }
    const listing = /^\/l\/([A-Za-z0-9_-]{22})$/.exec(url.pathname)?.[1];
    const handle = /^\/products\/([a-z0-9-]{1,64})$/.exec(url.pathname)?.[1];
    let product: { handle: string };
    if (listing) {
      const res = await fetch(`${origin}/api/listings/${listing}`);
      product = (await json<{ product: { handle: string } }>(res, "listing")).product;
    } else if (handle) {
      product = await json(await fetch(`${origin}/api/products/${handle}`), "product");
    } else {
      throw new CheckoutError("a proposed line is not a product page");
    }
    products.push(product);
    lines.push({ handle: product.handle, size: line.size, qty: line.qty });
  }
  const res = await fetch(`${origin}/api/cart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lines }),
  });
  const quoted = await json<Omit<Quote, "products">>(res, "cart");
  return { ...quoted, products };
}

/** The API Keelson serves to agents: `fetch` against its origin, or the app in process. */
export interface Keelson {
  request(path: string, init: RequestInit): Promise<Response> | Response;
}

/** The user's mandate as the agent holds it: open, with its key and the funds' hold. */
export interface Hold {
  mandateId: string;
  openMandate: string;
  agentKey: CryptoKey;
  authorizationId: string;
}

export interface CheckoutResult {
  requestId: string;
  evidenceRoot: string;
  /** Milliseconds per step: `capture`, `evidence`, `countersign`. */
  timings: Record<string, number>;
  capture: Pick<Capture, "findings" | "timings">;
  status: number;
  body: Record<string, unknown>;
}

const post = async (keelson: Keelson, path: string, headers: HeadersInit, body: unknown) => {
  const res = await keelson.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": ulid(), ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

/**
 * Seals what the agent saw at decision time, stores it with Keelson and asks Keelson to
 * countersign the cart under the mandate. Keelson decides; a DENY is an answer, not an error.
 */
export async function checkout(o: {
  keelson: Keelson;
  /** Sent with every Keelson call: the agent's credentials. */
  headers: HeadersInit;
  hold: Hold;
  session: Session;
  quote: Quote;
  /** The page reads the model received, as it received them. */
  observation: string;
  /** The age recipient that seals unredacted originals (`KEELSON_EVIDENCE_AGE_RECIPIENT`). */
  recipient: string;
}): Promise<CheckoutResult> {
  const timings: Record<string, number> = {};
  let t = performance.now();
  const cartResponse = { cart: o.quote.cart, total: o.quote.total };
  const capture = await captureEvidence(o.session.recorder, {
    product: o.quote.products.length === 1 ? o.quote.products[0] : o.quote.products,
    cart: cartResponse,
    llmObservation: o.observation,
    recipient: o.recipient,
  });
  timings.capture = performance.now() - t;

  t = performance.now();
  const stored = await post(o.keelson, "/v1/evidence", o.headers, {
    mandateId: o.hold.mandateId,
    manifest: capture.manifest,
    items: capture.items.map((i) => ({
      type: i.type,
      mediaType: i.mediaType,
      salt: Buffer.from(i.salt).toString("base64"),
      bytes: Buffer.from(i.bytes).toString("base64"),
    })),
  });
  if (stored.status !== 201) {
    throw new CheckoutError(`evidence not stored: HTTP ${stored.status} ${stored.body.type}`);
  }
  const evidenceRoot = stored.body.evidenceRoot as string;
  timings.evidence = performance.now() - t;

  t = performance.now();
  const requestId = ulid();
  const { cart, total } = o.quote;
  const value = (total.minor / 100).toFixed(2);
  const answer = await post(o.keelson, "/v1/countersign", o.headers, {
    authorizationId: o.hold.authorizationId,
    closedMandate: await closeMandate(
      o.hold.openMandate,
      { requestId, cartHash: `sha256:${toHex(cartHash(cart)).slice(2)}` },
      o.hold.agentKey,
    ),
    cart,
    unit: {
      amount: {
        currency_code: total.currency,
        value,
        breakdown: { item_total: { currency_code: total.currency, value } },
      },
    },
    evidenceRoot,
  });
  timings.countersign = performance.now() - t;
  return {
    requestId,
    evidenceRoot,
    timings,
    capture: { findings: capture.findings, timings: capture.timings },
    ...answer,
  };
}
