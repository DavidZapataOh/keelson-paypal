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
    const page = amberProduct(
      new URL("https://store.keelson.finance/api/products/tempo-3/variants/RF-TMP3-11"),
    );
    expect(
      amberProduct(
        new URL("https://STORE.keelson.finance/api/products/tempo-3/variants/RF-TMP3-11"),
      ),
    ).toBe(page);
    expect(
      amberProduct(
        new URL("https://store.keelson.finance/api/products/tempo-3/variants/RF-TMP3-11?x=1"),
      ),
    ).not.toBe(page);
    expect(page).toBe(0x1797628e5344cc4a8428fc94d110c65c7d2594aa5824778bdc17185a6828702an);
  });

  test("the commitment is the one the C2b circuit opens (circuits/c2b/src/vectors.nr)", async () => {
    const product = amberProduct(
      new URL("https://store.keelson.finance/api/products/tempo-3/variants/RF-TMP3-11"),
    );
    const amber = {
      sku: "RF-TMP3-11",
      size: "10",
      color: "blue",
      unitMinor: 12900n,
      returnsFree: true,
    };
    expect(await amberCommitment(product, amber, 0x0a3b3e5c1d2f40516273849506a7b8c9n)).toBe(
      0x0e9031affb017059e038d205ed727d9720f2c2b2e5c70c2684ab85b1d4724937n,
    );
    expect(
      await amberCommitment(product, { ...amber, size: "11" }, 0x0a3b3e5c1d2f40516273849506a7b8c9n),
    ).not.toBe(0x0e9031affb017059e038d205ed727d9720f2c2b2e5c70c2684ab85b1d4724937n);
  });
});
