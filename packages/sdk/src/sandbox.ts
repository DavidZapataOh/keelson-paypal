import { KeelsonError } from "./errors.ts";
import type { Cart } from "./types.ts";

/** Keelson's demo store, on the PayPal sandbox. */
export const SANDBOX_STORE = "https://store.keelson.finance";

export interface ProposedLine {
  /** A product page on the store, e.g. `https://store.keelson.finance/products/nike-pegasus-41`. */
  productUrl: string;
  size: string;
  qty: number;
}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new KeelsonError(`The store did not answer the ${what}: HTTP ${res.status}.`);
  return (await res.json()) as T;
}

/**
 * Prices a cart from the sandbox store itself: each product is read from its page's URL and the
 * cart, prices included, is the store's own answer. Returns the cart to countersign and the
 * store's answers to seal as evidence.
 */
export async function quote(
  lines: ProposedLine[],
  o: { store?: string } = {},
): Promise<{
  cart: Cart;
  total: { currency: string; minor: number };
  sources: { product: unknown; cart: Cart };
}> {
  const origin = new URL(o.store ?? SANDBOX_STORE).origin;
  if (origin !== SANDBOX_STORE && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    throw new KeelsonError(`quote() prices carts on ${SANDBOX_STORE} only.`);
  }
  const products: { handle: string }[] = [];
  for (const line of lines) {
    const url = URL.parse(line.productUrl, origin);
    if (!url || url.origin !== origin) throw new KeelsonError("A product is not on the store.");
    const listing = /^\/l\/([A-Za-z0-9_-]{22})$/.exec(url.pathname)?.[1];
    const handle = /^\/products\/([a-z0-9-]{1,64})$/.exec(url.pathname)?.[1];
    if (listing) {
      const res = await fetch(`${origin}/api/listings/${listing}`);
      products.push((await json<{ product: { handle: string } }>(res, "listing")).product);
    } else if (handle) {
      products.push(await json(await fetch(`${origin}/api/products/${handle}`), "product"));
    } else {
      throw new KeelsonError(`Not a product page: ${line.productUrl}`);
    }
  }
  const res = await fetch(`${origin}/api/cart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lines: lines.map((l, i) => ({ handle: products[i]?.handle, size: l.size, qty: l.qty })),
    }),
  });
  const quoted = await json<{ cart: Cart; total: { currency: string; minor: number } }>(
    res,
    "cart",
  );
  return {
    cart: quoted.cart,
    total: quoted.total,
    sources: { product: products.length === 1 ? products[0] : products, cart: quoted.cart },
  };
}
