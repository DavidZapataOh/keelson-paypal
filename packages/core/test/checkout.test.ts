import fc from "fast-check";
import { describe, expect, test } from "vitest";
import mismatch from "../../../engine/canon/tests/fixtures/breakdown-mismatch.json" with {
  type: "json",
};
import bundle from "../../../engine/canon/tests/fixtures/bundle-340.json" with { type: "json" };
import shoes from "../../../engine/canon/tests/fixtures/demo-shoes.json" with { type: "json" };
import type { Cart } from "../src/cart.ts";
import {
  CheckoutTotalError,
  captureCeiling,
  checkoutTotal,
  fromPayPalAmount,
  toPayPalAmount,
} from "../src/checkout.ts";
import { CURRENCIES, type CurrencyCode, fromPayPalValue, toPayPalValue } from "../src/money.ts";

const cart = (currency: string, ...lines: [qty: number, unit: number][]): Cart => ({
  merchant: "M",
  currency,
  lines: lines.map(([qty, unit_minor], i) => ({
    sku: `S${i}`,
    category: "gpt:1",
    qty,
    unit_minor,
  })),
  return_days: 0,
  returns_free: false,
});

const money = (currency_code: string, value: string) => ({ currency_code, value });

describe("a checkout total", () => {
  test("is the items plus tax and shipping, less discounts", () => {
    expect(checkoutTotal("USD", { items: 295, tax: 21, shipping: 500, discount: 100 })).toEqual({
      currency: "USD",
      items: 295,
      tax: 21,
      shipping: 500,
      discount: 100,
      minor: 716,
    });
    expect(checkoutTotal("USD", { items: 295 }).minor).toBe(295);
  });

  test("refuses a negative part, a fraction, a total below zero and an unknown currency", () => {
    expect(() => checkoutTotal("USD", { items: -1 })).toThrow(CheckoutTotalError);
    expect(() => checkoutTotal("USD", { items: 1.5 })).toThrow(CheckoutTotalError);
    expect(() => checkoutTotal("USD", { items: 100, discount: 101 })).toThrow(CheckoutTotalError);
    expect(() => checkoutTotal("KWD", { items: 100 })).toThrow(CheckoutTotalError);
    expect(() => checkoutTotal("USD", { items: Number.MAX_SAFE_INTEGER, tax: 1 })).toThrow(
      CheckoutTotalError,
    );
  });

  test("refuses a part PayPal cannot write in a currency without decimals", () => {
    expect(() => checkoutTotal("HUF", { items: 1000, tax: 50 })).toThrow(CheckoutTotalError);
    expect(checkoutTotal("HUF", { items: 1000, tax: 200 }).minor).toBe(1200);
  });
});

describe("as a PayPal amount", () => {
  test("writes every part in the currency's own decimals, and leaves zero parts out", () => {
    expect(toPayPalAmount(checkoutTotal("USD", { items: 295 }))).toEqual({
      currency_code: "USD",
      value: "2.95",
      breakdown: { item_total: money("USD", "2.95") },
    });
    expect(toPayPalAmount(checkoutTotal("JPY", { items: 1200, tax: 120, shipping: 500 }))).toEqual({
      currency_code: "JPY",
      value: "1820",
      breakdown: {
        item_total: money("JPY", "1200"),
        tax_total: money("JPY", "120"),
        shipping: money("JPY", "500"),
      },
    });
  });

  test("reads back what it writes, and the items are the cart's", () => {
    const c = cart("EUR", [2, 1050], [1, 99]);
    const t = checkoutTotal("EUR", { items: 2199, tax: 418, shipping: 490, discount: 200 });
    expect(fromPayPalAmount(toPayPalAmount(t), c)).toEqual(t);
  });

  test("refuses an amount whose parts do not add up to its value", () => {
    const a = toPayPalAmount(checkoutTotal("USD", { items: 295, tax: 21 }));
    expect(() => fromPayPalAmount({ ...a, value: "3.17" })).toThrow(/add up/);
  });

  test("refuses items that are not the cart's", () => {
    const a = toPayPalAmount(checkoutTotal("USD", { items: 295 }));
    expect(() => fromPayPalAmount(a, cart("USD", [2, 295]))).toThrow(/cart/);
  });

  test("refuses a part in another currency, or a cart in another", () => {
    const a = toPayPalAmount(checkoutTotal("USD", { items: 295, tax: 21 }));
    const other = { ...a, breakdown: { ...a.breakdown, tax_total: money("EUR", "0.21") } };
    expect(() => fromPayPalAmount(other)).toThrow(/currency/);
    expect(() => fromPayPalAmount(a, cart("EUR", [1, 295]))).toThrow(/currency/);
  });

  test("refuses the breakdown fields Keelson does not countersign, and any unknown field", () => {
    const a = toPayPalAmount(checkoutTotal("USD", { items: 295 }));
    for (const k of ["handling", "insurance", "shipping_discount", "other"]) {
      const b = { ...a, breakdown: { ...a.breakdown, [k]: money("USD", "0.00") } };
      expect(() => fromPayPalAmount(b), k).toThrow(CheckoutTotalError);
    }
    expect(() => fromPayPalAmount({ ...a, extra: 1 })).toThrow(CheckoutTotalError);
    const loose = { ...a, breakdown: { item_total: { ...money("USD", "2.95"), x: 1 } } };
    expect(() => fromPayPalAmount(loose)).toThrow(CheckoutTotalError);
  });

  test("refuses an amount with no item total, a malformed value or a negative one", () => {
    expect(() => fromPayPalAmount({ currency_code: "USD", value: "2.95" })).toThrow(
      CheckoutTotalError,
    );
    for (const value of ["2.955", "-1.00", "1e2", " 2.95", "02.95", ""]) {
      const a = { currency_code: "USD", value, breakdown: { item_total: money("USD", value) } };
      expect(() => fromPayPalAmount(a), value).toThrow(CheckoutTotalError);
    }
    expect(() => fromPayPalAmount(null)).toThrow(CheckoutTotalError);
    expect(() => fromPayPalAmount([])).toThrow(CheckoutTotalError);
  });

  test("reconciles the engine's own fixtures as the engine does, and refuses what it does not countersign", () => {
    expect(fromPayPalAmount(shoes.unit.amount, shoes.cart as Cart).minor).toBe(9400);
    expect(() => fromPayPalAmount(mismatch.unit.amount, mismatch.cart as Cart)).toThrow(/add up/);
    expect(() => fromPayPalAmount(bundle.unit.amount, bundle.cart as Cart)).toThrow(
      /shipping_discount/,
    );
  });

  test("any total in any PayPal currency round-trips exactly, and tampering with a part is caught", () => {
    const codes = Object.keys(CURRENCIES) as CurrencyCode[];
    const part = (code: CurrencyCode) => {
      const step = CURRENCIES[code].integerOnly ? 100 : 1;
      return fc.integer({ min: 0, max: 10_000_000 }).map((n) => n * step);
    };
    fc.assert(
      fc.property(
        fc.constantFrom(...codes).chain((code) =>
          fc.record({
            code: fc.constant(code),
            unit: part(code),
            qty: fc.integer({ min: 1, max: 20 }),
            tax: part(code),
            shipping: part(code),
            discount: part(code),
            bump: fc.constantFrom("value", "item_total", "tax_total", "shipping", "discount"),
          }),
        ),
        ({ code, unit, qty, tax, shipping, discount, bump }) => {
          const items = unit * qty;
          fc.pre(items + tax + shipping >= discount);
          const t = checkoutTotal(code, { items, tax, shipping, discount });
          const c = cart(code, [qty, unit]);
          const a = toPayPalAmount(t);
          expect(fromPayPalAmount(a, c)).toEqual(t);
          expect(t.minor).toBe(items + tax + shipping - discount);
          // One more of the smallest unit PayPal writes, anywhere, no longer reconciles.
          const step = BigInt(CURRENCIES[code].integerOnly ? 100 : 1);
          const tampered = structuredClone(a);
          const parts = tampered.breakdown as Record<
            string,
            { currency_code: string; value: string }
          >;
          if (bump !== "value")
            parts[bump] ??= money(code, toPayPalValue({ currency: code, minor: 0n }));
          const target = bump === "value" ? tampered : (parts[bump] as { value: string });
          target.value = toPayPalValue({
            currency: code,
            minor: fromPayPalValue(code, target.value).minor + step,
          });
          expect(() => fromPayPalAmount(tampered, c)).toThrow(CheckoutTotalError);
        },
      ),
      { numRuns: 2_000 },
    );
  });
});

describe("captureCeiling", () => {
  test("is 115% of an authorization, or USD 75 more when that is less", () => {
    expect(captureCeiling("USD", 295)).toBe(339);
    expect(captureCeiling("USD", 100_000)).toBe(107_500);
    expect(captureCeiling("USD", 50_000)).toBe(57_500);
    expect(captureCeiling("EUR", 100_000)).toBe(115_000);
  });
});
