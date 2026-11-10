import { describe, expect, test } from "vitest";
import { amberCommitment, amberProduct, packAmberString } from "../src/amber.ts";

describe("amber commitment", () => {
  test("a string packs as its length over its big-endian bytes, up to 30 bytes", () => {
    expect(packAmberString("")).toBe(0n);
    expect(packAmberString("10")).toBe((2n << 248n) + 0x3130n);
    expect(packAmberString("a".repeat(30))).toBe((30n << 248n) + BigInt(`0x${"61".repeat(30)}`));
    expect(() => packAmberString("a".repeat(31))).toThrow(RangeError);
    // A leading NUL byte changes the length, so it never packs like the shorter string.
    expect(packAmberString("\u00000")).not.toBe(packAmberString("0"));
  });

  test("the product names the page as the notary hashes it: lowercase host, path and query", () => {
    const page = amberProduct(new URL("https://store.keelson.finance/api/products/tempo-3"));
    expect(amberProduct(new URL("https://STORE.keelson.finance/api/products/tempo-3"))).toBe(page);
    expect(
      amberProduct(new URL("https://store.keelson.finance/api/products/tempo-3?x=1")),
    ).not.toBe(page);
    expect(page).toBe(0x2331e453b6124e47edc8e636aee16ab129ffe8a5cf71cf529a1e702345bc9d06n);
  });

  test("the commitment is the one the C2b circuit opens (circuits/c2b/src/vectors.nr)", async () => {
    const product = amberProduct(new URL("https://store.keelson.finance/api/products/tempo-3"));
    const amber = {
      sku: "RF-TMP3-11",
      size: "10",
      color: "blue",
      unitMinor: 12900n,
      returnsFree: true,
    };
    expect(await amberCommitment(product, amber, 0x0a3b3e5c1d2f40516273849506a7b8c9n)).toBe(
      0x1e49470de7af9aede92d4a09f488237805a511b68fd648fbd911bafedb959b8dn,
    );
    expect(
      await amberCommitment(product, { ...amber, size: "11" }, 0x0a3b3e5c1d2f40516273849506a7b8c9n),
    ).not.toBe(0x1e49470de7af9aede92d4a09f488237805a511b68fd648fbd911bafedb959b8dn);
  });
});
