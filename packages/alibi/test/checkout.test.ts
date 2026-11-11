import { checkoutTotal, type Json, jcs, sha256, toHex, toPayPalAmount } from "@keelson/core";
import { describe, expect, test } from "vitest";
import type { AlibiBundle } from "../src/schema.ts";
import { runCheck } from "../src/verify/check.ts";
import { checkout } from "../src/verify/checks/checkout.ts";

const cart = {
  merchant: "mrc_alfred",
  currency: "USD",
  lines: [
    { sku: "00-PS-0004070", size: null, color: null, category: "gpt:783", qty: 1, unit_minor: 295 },
  ],
  return_days: 0,
  returns_free: false,
};
const amount = toPayPalAmount(checkoutTotal("USD", { items: 295, tax: 21 }));
const hash = (v: unknown) => toHex(sha256(new TextEncoder().encode(jcs(v as Json))));

const bundle = (
  o: {
    checkout?: unknown;
    disclosed?: string;
    amount?: string;
    currency?: string;
    withCart?: boolean;
  } = {},
) =>
  ({
    type: "application/vnd.keelson.alibi.v1+json",
    tee: { countersign: { amount: o.amount ?? "316", currency: o.currency ?? "840" } },
    manifest: {
      public: { items: [{ type: "api.cart" }, { type: "api.checkout" }] },
      disclosures:
        o.checkout === null
          ? []
          : [{ type: "api.checkout", content_hash: o.disclosed ?? hash(o.checkout ?? amount) }],
    },
    ...(o.withCart === false ? {} : { cart }),
    ...(o.checkout === null ? {} : { checkout: o.checkout ?? amount }),
  }) as unknown as AlibiBundle;

const run = (b: AlibiBundle) =>
  runCheck(checkout, b, { now: new Date(), expect: undefined, chain: null });

describe("the checkout total of an Alibi", () => {
  test("passes when the disclosed amount reconciles with the cart and is the countersigned one", async () => {
    const c = await run(bundle());
    expect(c.status, c.reason).toBe("pass");
    expect(c.detail).toEqual({
      currency: "USD",
      items: "295",
      tax: "21",
      shipping: "0",
      discount: "0",
      total: "316",
    });
  });

  test("fails when the total is not the countersigned amount or currency", async () => {
    expect((await run(bundle({ amount: "295" }))).reason).toMatch(/countersigned amount/);
    expect((await run(bundle({ currency: "978" }))).reason).toMatch(/currency/);
  });

  test("fails when it is not the disclosed item, or its parts do not add up", async () => {
    expect((await run(bundle({ disclosed: `0x${"00".repeat(32)}` }))).reason).toMatch(/disclosed/);
    const off = { ...amount, value: "3.17" };
    expect((await run(bundle({ checkout: off, amount: "317" }))).reason).toMatch(/add up/);
  });

  test("fails when its items are not the disclosed cart's", async () => {
    const more = toPayPalAmount(checkoutTotal("USD", { items: 590, tax: 21 }));
    expect((await run(bundle({ checkout: more, amount: "611" }))).reason).toMatch(/cart/);
    expect((await run(bundle({ checkout: more, amount: "611", withCart: false }))).status).toBe(
      "undisclosed",
    );
  });

  test("is undisclosed when the manifest holds it and the Alibi leaves it out", async () => {
    expect((await run(bundle({ checkout: null }))).status).toBe("undisclosed");
  });
});
