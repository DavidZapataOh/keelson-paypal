import { describe, expect, it } from "vitest";
import { type AlibiFields, alibiDigest } from "../src/alibi.ts";
import { DST, hashObject, toHex } from "../src/hash.ts";
import { fromPayPalValue, type Money } from "../src/money.ts";
import vectors from "./vectors/alibi.json" with { type: "json" };

const fields: AlibiFields = {
  mandateHash: `0x${"11".repeat(32)}`,
  cartHash: `0x${"22".repeat(32)}`,
  policySetHash: `0x${"33".repeat(32)}`,
  countersignDigest: `0x${"44".repeat(32)}`,
  merchantId: "MERCHANT1",
  amount: { currency: "USD", minor: 1000n },
};

const snake = {
  mandate_hash: fields.mandateHash,
  cart_hash: fields.cartHash,
  policy_set_hash: fields.policySetHash,
  countersign_digest: fields.countersignDigest,
  merchant_id: "MERCHANT1",
  amount: "10.00",
  currency: "USD",
};

describe("alibiDigest", () => {
  it("hashes the snake_case object under the alibi tag", () => {
    expect(alibiDigest(fields)).toEqual(hashObject(DST.alibi, snake));
    expect(alibiDigest({ ...fields, paypalOrderId: "5O190127TN364715T" })).toEqual(
      hashObject(DST.alibi, { ...snake, paypal_order_id: "5O190127TN364715T" }),
    );
  });

  it("matches pinned vectors", () => {
    expect(toHex(alibiDigest(fields))).toBe(
      "0xa9bfed1cfc1b617e6512bcef367eb3a788df976d0405e2f304b86ac735e40506",
    );
    expect(toHex(alibiDigest({ ...fields, paypalOrderId: "5O190127TN364715T" }))).toBe(
      "0xb125aa17594491cd19c92041c89247ba704a7db126a43c95b33d1d522e8d29f9",
    );
  });

  it("gives one digest for every spelling of the same amount", () => {
    const digests = ["10", "10.0", "10.00"].map((value) =>
      toHex(alibiDigest({ ...fields, amount: fromPayPalValue("USD", value) })),
    );
    expect(new Set(digests)).toEqual(new Set([toHex(alibiDigest(fields))]));
  });

  it("formats the amount the way PayPal does", () => {
    const jpy: Money = { currency: "JPY", minor: 94n };
    expect(alibiDigest({ ...fields, amount: jpy })).toEqual(
      hashObject(DST.alibi, { ...snake, amount: "94", currency: "JPY" }),
    );
  });

  it("rejects amounts PayPal cannot represent", () => {
    expect(() => alibiDigest({ ...fields, amount: { currency: "HUF", minor: 150n } })).toThrow(
      RangeError,
    );
    expect(() =>
      alibiDigest({ ...fields, amount: { currency: "XXX", minor: 1n } as unknown as Money }),
    ).toThrow(TypeError);
  });
});

describe("golden vectors", () => {
  it.each(vectors)("$name", ({ input, expected }) => {
    const { amount, ...rest } = input as Omit<AlibiFields, "amount"> & {
      amount: { currency: Money["currency"]; minor: string };
    };
    expect(
      toHex(
        alibiDigest({
          ...rest,
          amount: { currency: amount.currency, minor: BigInt(amount.minor) },
        }),
      ),
    ).toBe(expected);
  });
});
