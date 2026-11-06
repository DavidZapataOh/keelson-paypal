import { describe, expect, it } from "vitest";
import { type Cart, cartHash } from "../src/cart.ts";
import { DST, hashObject, toHex } from "../src/hash.ts";
import vectors from "./vectors/cart-hash.json" with { type: "json" };

const shoes: Cart = {
  merchant: "mrc_runfast",
  currency: "USD",
  lines: [{ sku: "SOCK-6", color: "white", category: "gpt:1604", qty: 3, unit_minor: 1500 }],
  return_days: 14,
  returns_free: false,
};

describe("cartHash", () => {
  it("matches the vectors", () => {
    expect(vectors).toHaveLength(6);
    for (const v of vectors) expect(toHex(cartHash(v.input as Cart)), v.name).toBe(v.expected);
  });

  it("hashes an absent size or color as null", () => {
    const line = { ...shoes.lines[0], size: null } as Cart["lines"][number];
    expect(cartHash(shoes)).toEqual(cartHash({ ...shoes, lines: [line] }));
    expect(toHex(cartHash(shoes))).toBe(
      toHex(hashObject(DST.cart, { ...shoes, lines: [{ ...line, size: null }] })),
    );
  });

  it("ignores members outside the cart", () => {
    const extra = { ...shoes, note: "x" } as Cart;
    expect(cartHash(extra)).toEqual(cartHash(shoes));
  });

  it("commits to every member", () => {
    const base = toHex(cartHash(shoes));
    const line = shoes.lines[0] as Cart["lines"][number];
    const variants: Cart[] = [
      { ...shoes, merchant: "mrc_other" },
      { ...shoes, currency: "EUR" },
      { ...shoes, return_days: 30 },
      { ...shoes, returns_free: true },
      { ...shoes, lines: [{ ...line, qty: 2 }] },
      { ...shoes, lines: [{ ...line, unit_minor: 1501 }] },
      { ...shoes, lines: [{ ...line, size: "M" }] },
      { ...shoes, lines: [line, line] },
    ];
    for (const v of variants) expect(toHex(cartHash(v))).not.toBe(base);
  });
});
