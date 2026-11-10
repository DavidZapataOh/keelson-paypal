import { cartHash } from "@keelson/core";
import { describe, expect, test } from "vitest";
import { MERCHANT_ID, PRODUCTS, QuoteError, quote } from "../src/catalog.ts";

describe("catalog", () => {
  test("handles and SKUs are unique and prices are whole minor units", () => {
    expect(new Set(PRODUCTS.map((p) => p.handle)).size).toBe(PRODUCTS.length);
    expect(new Set(PRODUCTS.map((p) => p.sku)).size).toBe(PRODUCTS.length);
    for (const p of PRODUCTS) {
      expect(Number.isSafeInteger(p.priceMinor) && p.priceMinor > 0).toBe(true);
      expect(p.sizes.length).toBeGreaterThan(0);
      expect(p.handle).toMatch(/^[a-z0-9-]+$/);
    }
  });

  test("the premium bundle costs $340.00", () => {
    expect(PRODUCTS.find((p) => p.handle === "premium-bundle")?.priceMinor).toBe(34000);
  });

  test("cart lines name Google Product Taxonomy categories, which the engine checks", () => {
    const bundle = quote([{ handle: "premium-bundle", size: "10", qty: 1 }]);
    expect(bundle.cart.lines[0]?.category).toBe("gpt:988");
  });

  test("a quote is the cart the engine hashes, priced from the catalog", () => {
    const shoe = PRODUCTS[0];
    if (!shoe) throw new Error("empty catalog");
    const size = shoe.sizes[0] as string;
    const q = quote([{ handle: shoe.handle, size, qty: 2 }]);
    expect(q.cart).toEqual({
      merchant: MERCHANT_ID,
      currency: "USD",
      lines: [
        {
          sku: `${shoe.sku}-${size}`,
          size,
          color: shoe.color,
          category: "gpt:187",
          qty: 2,
          unit_minor: shoe.priceMinor,
        },
      ],
      return_days: 30,
      returns_free: true,
    });
    expect(q.total).toEqual({ currency: "USD", minor: BigInt(shoe.priceMinor * 2) });
    expect(Buffer.from(cartHash(q.cart)).toString("hex")).toBe(
      Buffer.from(cartHash(quote([{ handle: shoe.handle, size, qty: 2 }]).cart)).toString("hex"),
    );
  });

  test.each([
    ["an unknown product", [{ handle: "nope", size: "10", qty: 1 }]],
    ["an unknown size", [{ handle: "tempo-3", size: "99", qty: 1 }]],
    ["no quantity", [{ handle: "tempo-3", size: "10", qty: 0 }]],
    ["more than five of one line", [{ handle: "tempo-3", size: "10", qty: 6 }]],
    ["a fractional quantity", [{ handle: "tempo-3", size: "10", qty: 1.5 }]],
    ["no lines", []],
    [
      "more than ten lines",
      Array.from({ length: 11 }, () => ({ handle: "tempo-3", size: "10", qty: 1 })),
    ],
  ])("rejects %s", (_, lines) => {
    expect(() => quote(lines)).toThrow(QuoteError);
  });
});
