import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Conversion,
  commitReference,
  conversionProblem,
  convertsTo,
  decimalOf,
  decimalParts,
  describeConversion,
  referenceProblem,
  spreadBps,
} from "../src/fx.ts";

/** USD 2.95 converted as PayPal shows it to a buyer in each currency; the rates are made up. */
const SHOWN = [
  { currency: "COP", rate: "3468.14", buyer: "10231", locale: "es-CO" },
  { currency: "BRL", rate: "5.8231", buyer: "17.18", locale: "pt-BR" },
  { currency: "JPY", rate: "162.47", buyer: "479", locale: "ja-JP" },
  { currency: "EUR", rate: "0.9312", buyer: "2.75", locale: "de-DE" },
  { currency: "MXN", rate: "19.4127", buyer: "57.27", locale: "es-MX" },
  { currency: "KWD", rate: "0.3189", buyer: "0.941", locale: "ar-KW" },
  { currency: "INR", rate: "88.6214", buyer: "261.43", locale: "hi-IN" },
  { currency: "GBP", rate: "0.7931", buyer: "2.34", locale: "en-GB" },
] as const;

const conversion = (o: Partial<Conversion> = {}): Conversion => ({
  v: "keelson.conversion/1",
  merchant: { currency: "USD", value: "2.95" },
  buyer: { currency: "COP", value: "10231" },
  rate: "3468.14",
  reference: {
    rate: "3276.876985",
    provider: "ExchangeRate-API",
    source: "https://open.er-api.com/v6/latest/USD",
    as_of: "2026-11-11T00:02:32.000Z",
  },
  spread_bps: 584,
  max_spread_bps: 750,
  locale: "es-CO",
  ...o,
});

describe("a converted total", () => {
  it.each(SHOWN)("USD 2.95 is $buyer $currency at $rate", ({ rate, buyer }) => {
    expect(convertsTo("2.95", rate, buyer)).toBe(true);
  });

  it.each(SHOWN)("one more of the last digit shown in $currency is refused", ({ rate, buyer }) => {
    const { int, scale } = decimalParts(buyer);
    const up = (int + 2n).toString().padStart(scale + 1, "0");
    const more = scale ? `${up.slice(0, -scale)}.${up.slice(-scale)}` : up;
    expect(convertsTo("2.95", rate, more)).toBe(false);
  });

  it("a wrong rate does not convert the total", () => {
    expect(convertsTo("2.95", "3500.00", "10231")).toBe(false);
    expect(convertsTo("2.95", "3468.14", "10325")).toBe(false);
  });

  it("is exact on any amount and rate, within one shown digit plus the rate's rounding", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000_000 }),
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 1000, max: 10 ** 9 }),
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 3 }),
        (mInt, mScale, rInt, rScale, bScale) => {
          const dec = (i: bigint, s: number) => {
            const t = i.toString().padStart(s + 1, "0");
            return s ? `${t.slice(0, -s)}.${t.slice(-s)}` : t;
          };
          const merchant = dec(BigInt(mInt), mScale);
          const rate = dec(BigInt(rInt), rScale);
          // The exact product, rounded half up to bScale decimals: what PayPal shows.
          const exact = BigInt(mInt) * BigInt(rInt);
          const from = mScale + rScale;
          const scaled =
            from >= bScale
              ? (exact * 2n + 10n ** BigInt(from - bScale)) / (2n * 10n ** BigInt(from - bScale))
              : exact * 10n ** BigInt(bScale - from);
          expect(convertsTo(merchant, rate, dec(scaled, bScale))).toBe(true);
          // Off by more than the bound: one shown digit and a half rate digit on the amount.
          const half = 2n * 10n ** BigInt(from);
          const off = scaled + 2n + (BigInt(mInt) * 10n ** BigInt(bScale) + half - 1n) / half;
          expect(convertsTo(merchant, rate, dec(off, bScale))).toBe(false);
        },
      ),
      { numRuns: 5_000 },
    );
  });
});

describe("the spread over the reference", () => {
  it("is rounded up in basis points, either way", () => {
    expect(spreadBps("3468.14", "3276.876985")).toBe(584);
    expect(spreadBps("100", "100")).toBe(0);
    expect(spreadBps("99", "100")).toBe(100);
    expect(spreadBps("100.0001", "100")).toBe(1);
  });

  it("is the relative distance on any rates", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 ** 9 }),
        fc.integer({ min: 1, max: 10 ** 9 }),
        (a, b) => {
          const exact = (Math.abs(a - b) * 10_000) / b;
          const got = spreadBps(String(a), String(b));
          expect(got).toBeGreaterThanOrEqual(exact - 1e-6);
          expect(got).toBeLessThan(exact + 1);
        },
      ),
    );
  });
});

describe("a recorded conversion", () => {
  it("holds together", () => {
    expect(conversionProblem(conversion())).toBeUndefined();
  });

  it("is refused for a wrong rate, a wrong spread, a spread over the cap or one currency", () => {
    expect(conversionProblem(conversion({ rate: "3500.00" }))).toMatch(/PayPal's rate/);
    expect(conversionProblem(conversion({ spread_bps: 500 }))).toMatch(/spread is not/);
    expect(conversionProblem(conversion({ max_spread_bps: 500 }))).toMatch(/over the mandate/);
    expect(conversionProblem(conversion({ buyer: { currency: "USD", value: "2.95" } }))).toMatch(
      /merchant's currency/,
    );
  });

  it("reads as the receipt states it", () => {
    expect(describeConversion(conversion())).toBe("Paid 10.231 COP (USD 2.95 at 3.468,14)");
  });

  it("writes provider rates as plain decimals", () => {
    expect(decimalOf(3276.876985)).toBe("3276.876985");
    expect(decimalOf(1e-7)).toBe("0.0000001");
  });
});

describe("a reference bound into the evidence", () => {
  const ref = {
    v: "keelson.fx_reference/1" as const,
    provider: "ExchangeRate-API",
    source: "https://open.er-api.com/v6/latest/USD",
    base: "USD",
    as_of: "2026-11-11T00:02:32.000Z",
    fetched_at: "2026-11-11T12:00:00.000Z",
    rates: { COP: "3276.876985", EUR: "0.89871" },
  };

  it("holds each rate as a digest, and a conversion opens only its own", () => {
    const committed = commitReference(ref);
    expect(Object.keys(committed.rates)).toEqual(["COP", "EUR"]);
    expect(JSON.stringify(committed)).not.toContain("3276");
    const c: Conversion = {
      v: "keelson.conversion/1",
      merchant: { currency: "USD", value: "2.95" },
      buyer: { currency: "COP", value: "10231" },
      rate: "3468.14",
      reference: {
        rate: "3276.876985",
        provider: ref.provider,
        source: ref.source,
        as_of: ref.as_of,
      },
      spread_bps: 584,
      max_spread_bps: 750,
      locale: "es-CO",
    };
    expect(referenceProblem(c, committed)).toBeUndefined();
    expect(
      referenceProblem({ ...c, reference: { ...c.reference, rate: "3400" } }, committed),
    ).toMatch(/rate is not/);
    expect(
      referenceProblem(
        { ...c, reference: { ...c.reference, as_of: "2026-11-10T00:00:00Z" } },
        committed,
      ),
    ).toMatch(/not the one/);
  });
});
