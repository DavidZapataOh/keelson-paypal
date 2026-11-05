// Currency list: https://developer.paypal.com/reference/currency-codes/ (page "Last updated:
// August 17, 2026"), accessed 2026-11-05. HUF, JPY and TWD are listed there as zero-digit
// currencies ("no decimal places or fractions"). ISO 4217 numeric codes and minor units
// cross-checked against the datasets/currency-codes ISO 4217 table.
import { describe, expect, it } from "vitest";
import {
  CURRENCIES,
  type CurrencyCode,
  currencyNumeric,
  fromPayPalValue,
  toPayPalValue,
} from "../src/money.js";

const PAYPAL_CURRENCIES = [
  ["AUD", 36],
  ["BRL", 986],
  ["CAD", 124],
  ["CNY", 156],
  ["CZK", 203],
  ["DKK", 208],
  ["EUR", 978],
  ["HKD", 344],
  ["HUF", 348],
  ["ILS", 376],
  ["JPY", 392],
  ["MYR", 458],
  ["MXN", 484],
  ["TWD", 901],
  ["NZD", 554],
  ["NOK", 578],
  ["PHP", 608],
  ["PLN", 985],
  ["GBP", 826],
  ["SGD", 702],
  ["SEK", 752],
  ["CHF", 756],
  ["THB", 764],
  ["USD", 840],
] as const;

describe("CURRENCIES", () => {
  it("covers exactly the PayPal list with ISO 4217 numeric codes", () => {
    expect(Object.keys(CURRENCIES).sort()).toEqual(PAYPAL_CURRENCIES.map(([c]) => c).sort());
    for (const [code, numeric] of PAYPAL_CURRENCIES) {
      expect(CURRENCIES[code].numeric).toBe(numeric);
    }
  });

  it("marks the zero-digit currencies", () => {
    expect(CURRENCIES.USD).toEqual({ numeric: 840, exponent: 2, integerOnly: false });
    expect(CURRENCIES.JPY).toEqual({ numeric: 392, exponent: 0, integerOnly: true });
    expect(CURRENCIES.HUF).toEqual({ numeric: 348, exponent: 2, integerOnly: true });
    expect(CURRENCIES.TWD).toEqual({ numeric: 901, exponent: 2, integerOnly: true });
    const integerOnly = Object.entries(CURRENCIES)
      .filter(([, v]) => v.integerOnly)
      .map(([k]) => k);
    expect(integerOnly.sort()).toEqual(["HUF", "JPY", "TWD"]);
  });
});

describe("toPayPalValue", () => {
  it("formats two-decimal currencies", () => {
    expect(toPayPalValue({ currency: "USD", minor: 9400n })).toBe("94.00");
    expect(toPayPalValue({ currency: "USD", minor: 5n })).toBe("0.05");
    expect(toPayPalValue({ currency: "USD", minor: 0n })).toBe("0.00");
    expect(toPayPalValue({ currency: "USD", minor: -150n })).toBe("-1.50");
    expect(toPayPalValue({ currency: "USD", minor: 123456789012345678901n })).toBe(
      "1234567890123456789.01",
    );
  });

  it("formats zero-exponent currencies without decimals", () => {
    expect(toPayPalValue({ currency: "JPY", minor: 94n })).toBe("94");
  });

  it("formats integer-only currencies and rejects fractions", () => {
    expect(toPayPalValue({ currency: "HUF", minor: 15000n })).toBe("150");
    expect(() => toPayPalValue({ currency: "HUF", minor: 150n })).toThrow();
    expect(() => toPayPalValue({ currency: "TWD", minor: 1n })).toThrow();
  });
});

describe("fromPayPalValue", () => {
  it("parses decimal strings exactly", () => {
    expect(fromPayPalValue("USD", "0.10").minor).toBe(10n);
    expect(fromPayPalValue("USD", "94.00")).toEqual({ currency: "USD", minor: 9400n });
    expect(fromPayPalValue("USD", "94")).toEqual({ currency: "USD", minor: 9400n });
    expect(fromPayPalValue("USD", "-1.5").minor).toBe(-150n);
    expect(fromPayPalValue("JPY", "94").minor).toBe(94n);
    expect(fromPayPalValue("HUF", "150").minor).toBe(15000n);
  });

  it("rejects excess precision and malformed input", () => {
    for (const bad of [
      "1.005",
      "1e2",
      "",
      " 1",
      "1 ",
      "+1",
      ".5",
      "1.",
      "01",
      "1,00",
      "0x10",
      "-0",
    ]) {
      expect(() => fromPayPalValue("USD", bad), bad).toThrow();
    }
  });

  it("rejects decimals where the currency has none", () => {
    expect(() => fromPayPalValue("JPY", "94.00")).toThrow();
    expect(() => fromPayPalValue("HUF", "150.50")).toThrow();
  });

  it("round-trips with toPayPalValue", () => {
    for (const currency of Object.keys(CURRENCIES) as CurrencyCode[]) {
      const m = fromPayPalValue(currency, "12345");
      expect(fromPayPalValue(currency, toPayPalValue(m))).toEqual(m);
    }
  });
});

describe("currencyNumeric", () => {
  it("returns the ISO 4217 numeric code", () => {
    expect(currencyNumeric("USD")).toBe(840);
  });
});
