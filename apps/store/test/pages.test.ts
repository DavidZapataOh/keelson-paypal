import { describe, expect, test } from "vitest";
import { PRODUCTS } from "../src/catalog.ts";
import { jsonLd, ORIGIN, req } from "./setup.ts";

describe("pages", () => {
  test("the catalog links every product", async () => {
    const res = await req("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const p of PRODUCTS) expect(html).toContain(`href="/products/${p.handle}"`);
  });

  test.each(PRODUCTS.map((p) => [p.handle, p] as const))(
    "%s has one JSON-LD Product priced from the catalog",
    async (handle, p) => {
      const res = await req(`/products/${handle}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/html/);
      const html = await res.text();
      const blocks = jsonLd(html);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        "@context": "https://schema.org",
        "@type": "Product",
        name: p.title,
        sku: p.sku,
        brand: { "@type": "Brand", name: "RunFast" },
        offers: {
          "@type": "Offer",
          url: `${ORIGIN}/products/${handle}`,
          price: (p.priceMinor / 100).toFixed(2),
          priceCurrency: "USD",
          availability: "https://schema.org/InStock",
        },
      });
      expect(html).toContain("<paypal-button");
      for (const size of p.sizes) expect(html).toContain(`name="size" value="${size}"`);
      expect(new TextEncoder().encode(html).length).toBeLessThanOrEqual(20_000);
    },
  );

  test("unknown products and pages are 404", async () => {
    expect((await req("/products/nope")).status).toBe(404);
    expect((await req("/api/products/nope")).status).toBe(404);
    expect((await req("/nope")).status).toBe(404);
  });

  test("the product JSON is what the agent captures", async () => {
    const p = PRODUCTS[0];
    if (!p) throw new Error("empty catalog");
    const res = await req(`/api/products/${p.handle}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      merchant: "mrc_runfast",
      handle: p.handle,
      sku: p.sku,
      title: p.title,
      brand: "RunFast",
      category: p.category,
      color: p.color,
      description: p.description,
      url: `${ORIGIN}/products/${p.handle}`,
      price: {
        currency: "USD",
        minor: p.priceMinor,
        display: `$${(p.priceMinor / 100).toFixed(2)}`,
      },
      available: true,
      sizes: p.sizes,
      return_days: 30,
      returns_free: true,
    });
    const all = (await (await req("/api/products")).json()) as { handle: string }[];
    expect(all.map((x) => x.handle)).toEqual(PRODUCTS.map((x) => x.handle));
  });

  test("the cart endpoint quotes lines and rejects bad ones", async () => {
    const post = (body: unknown) =>
      req("/api/cart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const ok = await post({ lines: [{ handle: "tempo-3", size: "10", qty: 1 }] });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      cart: { merchant: "mrc_runfast", lines: [{ sku: "RF-TMP3-10", unit_minor: 12900 }] },
      total: { currency: "USD", minor: 12900, display: "$129.00" },
    });
    const bad = await post({ lines: [{ handle: "tempo-3", size: "99", qty: 1 }] });
    expect(bad.status).toBe(422);
    expect(bad.headers.get("content-type")).toBe("application/problem+json");
    expect((await post({ nope: true })).status).toBe(422);
  });

  test("pages carry a CSP with a per-response script nonce", async () => {
    const res = await req("/products/tempo-3");
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await res.text();
    for (const tag of html.match(/<script(?![^>]*application\/ld\+json)[^>]*>/g) ?? []) {
      expect(tag).toContain(`nonce="${nonce}"`);
    }
    const again = (await req("/products/tempo-3")).headers.get("content-security-policy");
    expect(again).not.toBe(csp);
  });

  test("health", async () => {
    expect((await req("/health")).status).toBe(200);
  });
});
