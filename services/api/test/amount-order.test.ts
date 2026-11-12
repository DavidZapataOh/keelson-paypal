import { checkoutTotal } from "@keelson/core";
import { describe, expect, test } from "vitest";
import { AmountMismatch, compareOrder, orderFacts } from "../src/amount.ts";
import authorizeUsd from "./fixtures/paypal-orders/authorize-usd.json" with { type: "json" };
import captureJpy from "./fixtures/paypal-orders/capture-jpy.json" with { type: "json" };
import captureUsd from "./fixtures/paypal-orders/capture-usd.json" with { type: "json" };
import plainUsd from "./fixtures/paypal-orders/capture-usd-plain.json" with { type: "json" };

const PAYEE = "A4WCRYD5EYDF2";
const allowed = (p: string) => p === PAYEE;
const usd1234 = checkoutTotal("USD", { items: 1000, tax: 84, shipping: 150 });

const mismatch = (f: () => void): string | undefined => {
  try {
    f();
  } catch (e) {
    if (e instanceof AmountMismatch) return e.field;
    throw e;
  }
  return undefined;
};

describe("orderFacts", () => {
  test("reads an Orders v2 order as PayPal returns it", () => {
    expect(orderFacts(captureUsd)).toEqual({
      orderId: captureUsd.id,
      status: "CREATED",
      intent: "CAPTURE",
      currency: "USD",
      total: usd1234,
      breakdown: true,
      payee: PAYEE,
      units: 1,
    });
  });

  test("reads zero-decimal currencies and AUTHORIZE orders", () => {
    const jpy = orderFacts(captureJpy);
    expect(jpy.currency).toBe("JPY");
    expect(jpy.total.minor).toBe(1500);
    expect(orderFacts(authorizeUsd).intent).toBe("AUTHORIZE");
  });

  test("an order without a breakdown has only its total", () => {
    const f = orderFacts(plainUsd);
    expect(f.breakdown).toBe(false);
    expect(f.total.minor).toBe(295);
  });

  test("refuses several purchase units", () => {
    // A constructed negative case: PayPal returned one unit, a second is a copy of it.
    const two = structuredClone(captureUsd);
    two.purchase_units.push(structuredClone(two.purchase_units[0] as never));
    expect(mismatch(() => orderFacts(two))).toBe("units");
  });

  test("refuses an order that can no longer be paid", () => {
    expect(mismatch(() => orderFacts({ ...captureUsd, status: "VOIDED" }))).toBe("status");
    expect(mismatch(() => orderFacts({ ...captureUsd, status: "COMPLETED" }))).toBe("status");
  });

  test("refuses an answer that is not an order", () => {
    expect(mismatch(() => orderFacts(null))).toBe("order");
    expect(mismatch(() => orderFacts({ id: "X" }))).toBe("order");
  });
});

describe("compareOrder", () => {
  const facts = orderFacts(captureUsd);

  test("passes the countersigned total, currency, breakdown and payee", () => {
    expect(mismatch(() => compareOrder(facts, usd1234, allowed))).toBeUndefined();
  });

  test("one minor unit off is a total mismatch", () => {
    const less = checkoutTotal("USD", { items: 999, tax: 84, shipping: 150 });
    expect(mismatch(() => compareOrder(facts, less, allowed))).toBe("total");
  });

  test("another currency is a currency mismatch", () => {
    const eur = checkoutTotal("EUR", { items: 1000, tax: 84, shipping: 150 });
    expect(mismatch(() => compareOrder(facts, eur, allowed))).toBe("currency");
  });

  test("a payee the mandate does not name is a payee mismatch", () => {
    expect(mismatch(() => compareOrder(facts, usd1234, () => false))).toBe("payee");
  });

  test("the same total split otherwise is a breakdown mismatch", () => {
    const split = checkoutTotal("USD", { items: 1084, shipping: 150 });
    expect(mismatch(() => compareOrder(facts, split, allowed))).toBe("breakdown");
  });

  test("an order with no breakdown compares on its total only", () => {
    const plain = orderFacts(plainUsd);
    const total = checkoutTotal("USD", { items: 250, tax: 45 });
    expect(mismatch(() => compareOrder(plain, total, allowed))).toBeUndefined();
  });

  test("compares the order's currency, never a buyer-side conversion", () => {
    // The buyer may fund a USD order in COP: the total compared is the order's, in USD.
    expect(mismatch(() => compareOrder(facts, { ...usd1234, currency: "COP" }, allowed))).toBe(
      "currency",
    );
  });
});
