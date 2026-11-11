import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { bare, type LiveStore, quoteShopify, shopifyCart } from "../src/live.ts";

const product = (price: number) => ({
  id: 1,
  handle: "the-change",
  title: "The Change",
  variants: [
    { id: 44631538991240, sku: "00-PS-0004070", title: "Default Title", price, available: true },
  ],
});
const oembed = (price: number, currency = "USD") => ({
  offers: [{ offer_id: 44631538991240, price, currency_code: currency, in_stock: true }],
});

describe("pricing a cart from a Shopify store's public product JSON", () => {
  let server: Server;
  let store: LiveStore;
  const routes: Record<string, unknown> = {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = routes[req.url ?? ""];
      res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(body ?? {}));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    store = {
      origin,
      merchant: "mrc_alfred",
      category: "gpt:887",
      returnDays: 0,
      returnsFree: false,
      hosts: ["127.0.0.1"],
      checkoutHosts: [],
    };
  });
  afterAll(() => new Promise((r) => server.close(r)));

  const propose = (path: string, qty = 1) => ({
    lines: [{ product_url: `${store.origin}${path}`, size: "", qty }],
    reason: "",
  });

  test("the cart is the store's variant, price and currency, labeled as the store is", async () => {
    routes["/products/the-change.js"] = product(295);
    routes["/products/the-change.oembed"] = oembed(2.95);
    const quote = await quoteShopify(store, propose("/products/the-change", 2));
    expect(quote.cart).toEqual({
      merchant: "mrc_alfred",
      currency: "USD",
      lines: [
        {
          sku: "00-PS-0004070",
          size: null,
          color: null,
          category: "gpt:887",
          qty: 2,
          unit_minor: 295,
        },
      ],
      return_days: 0,
      returns_free: false,
    });
    expect(quote.total).toEqual({ currency: "USD", minor: 590, display: "5.90" });
  });

  test("a line off the store, or not a product page, is refused", async () => {
    await expect(
      quoteShopify(store, {
        lines: [{ product_url: "https://evil.example/products/the-change", size: "", qty: 1 }],
        reason: "",
      }),
    ).rejects.toThrow(/not a product page/);
    await expect(quoteShopify(store, propose("/cart"))).rejects.toThrow(/not a product page/);
  });

  test("endpoints that disagree on the price are refused", async () => {
    routes["/products/drift.js"] = { ...product(295), handle: "drift" };
    routes["/products/drift.oembed"] = oembed(1.95);
    await expect(quoteShopify(store, propose("/products/drift"))).rejects.toThrow(/disagree/);
  });

  test("the run's log keeps no query string a checkout URL carries", () => {
    expect(bare("https://www.paypal.com/checkoutnow?token=EC-123&useraction=commit#x")).toBe(
      "https://www.paypal.com/checkoutnow",
    );
  });

  test("the store's cart is read in the currency's minor units", async () => {
    const api = await request.newContext();
    try {
      routes["/cart.js"] = { currency: "USD", total_price: 295 };
      expect(await shopifyCart({ request: api }, store.origin)()).toEqual({
        currency: "USD",
        minor: 295,
      });
      routes["/cart.js"] = { currency: "JPY", total_price: 123_400 };
      expect(await shopifyCart({ request: api }, store.origin)()).toEqual({
        currency: "JPY",
        minor: 1234,
      });
      routes["/cart.js"] = { currency: "USD" };
      expect(await shopifyCart({ request: api }, store.origin)()).toBeUndefined();
    } finally {
      await api.dispose();
    }
  });
});
