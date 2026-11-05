import { describe, expect, it } from "vitest";
import { DST, type Dst, fromHex, hashObject, sha256, toHex } from "../src/hash.js";
import type { Json } from "../src/jcs.js";
import vectors from "./vectors/hash.json" with { type: "json" };

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("hashObject", () => {
  it("is SHA-256 over dst, a zero byte and the canonical JSON", () => {
    expect(toHex(hashObject(DST.cart, {}))).toBe(toHex(sha256(utf8("keelson/cart/v1\u0000{}"))));
  });

  it("is independent of key order", () => {
    expect(toHex(hashObject(DST.mandate, { a: 1, b: [2, 3] }))).toBe(
      toHex(hashObject(DST.mandate, { b: [2, 3], a: 1 })),
    );
  });

  it("separates domains", () => {
    expect(toHex(hashObject(DST.cart, {}))).not.toBe(toHex(hashObject(DST.verdict, {})));
  });

  it("returns 32 bytes", () => {
    expect(hashObject(DST.alibi, [])).toHaveLength(32);
  });
});

describe("DST", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(DST)).toBe(true);
  });

  it("has the exact domain strings", () => {
    expect(DST).toEqual({
      mandate: "keelson/mandate/v1",
      mandateChallenge: "keelson/mandate-challenge/v1",
      cart: "keelson/cart/v1",
      evidenceItem: "keelson/evidence-item/v1",
      eval: "keelson/eval/v1",
      alibi: "keelson/alibi/v1",
      verdict: "keelson/verdict/v1",
    });
  });
});

describe("hex", () => {
  it("round-trips", () => {
    const bytes = Uint8Array.from([0, 1, 254, 255]);
    expect(toHex(bytes)).toBe("0x0001feff");
    expect(fromHex("0x0001feff")).toEqual(bytes);
    expect(fromHex("0001FEFF")).toEqual(bytes);
  });

  it("rejects malformed input", () => {
    expect(() => fromHex("0x123")).toThrow();
    expect(() => fromHex("0xzz")).toThrow();
  });
});

describe("golden vectors", () => {
  it.each(vectors)("$name", ({ input, expected }) => {
    expect(toHex(hashObject(input.dst as Dst, input.value as Json))).toBe(expected);
  });
});
