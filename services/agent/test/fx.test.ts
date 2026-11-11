import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { judge, readPage } from "../src/amounts.ts";
import { BUYERS, convert, money, reviewText } from "./fixtures/paypal-pages.ts";

const read = (lines: string[], locale: string) => readPage(lines.join("\n"), [locale], "USD");

describe("a PayPal review page that converts a USD order", () => {
  test.each(BUYERS)("to $currency in $locale reads PayPal's total and rate", (buyer) => {
    for (const locale of [buyer.locale, "en-US"]) {
      const judged = judge(read(reviewText({ buyer, usd: 295 }), locale), 295, "USD", true, false);
      expect(judged, `${buyer.currency} ${locale}`).toEqual({
        ok: true,
        conversion: {
          currency: buyer.currency,
          rate: buyer.rate,
          buyer: convert(295, buyer.rate, buyer.shown),
          locale,
        },
      });
    }
  });

  test.each(BUYERS)("to $currency is held for a wrong rate", (buyer) => {
    const lines = reviewText({ buyer, usd: 295, rate: (Number(buyer.rate) * 1.01).toFixed(4) });
    expect(judge(read(lines, buyer.locale), 295, "USD", true, false).ok).toBe(false);
  });

  test.each(BUYERS)("to $currency is held with no rate line", (buyer) => {
    const lines = reviewText({ buyer, usd: 295, rate: null });
    expect(judge(read(lines, buyer.locale), 295, "USD", true, false)).toMatchObject({ ok: false });
  });

  test.each(BUYERS)("to $currency is held for rates that disagree", (buyer) => {
    const other = (Number(buyer.rate) * 1.02).toFixed(4);
    const lines = reviewText({ buyer, usd: 295, extra: [`1 USD = ${other} ${buyer.currency}`] });
    expect(judge(read(lines, "en-US"), 295, "USD", true, false)).toMatchObject({ ok: false });
  });

  test.each(BUYERS)("to $currency is held for a larger hidden amount, in either currency", (b) => {
    const usd = reviewText({ buyer: b, usd: 295, extra: ["Fee $5.00 USD"] });
    expect(judge(read(usd, "en-US"), 295, "USD", true, false).ok).toBe(false);
    const big = convert(2_950, b.rate, b.shown);
    const local = reviewText({
      buyer: b,
      usd: 295,
      extra: [`Fee ${money(big, b.currency, "en-US")}`],
    });
    expect(judge(read(local, "en-US"), 295, "USD", true, false).ok).toBe(false);
  });

  test.each(BUYERS)("to $currency is held when it charges a third currency", (buyer) => {
    const third = buyer.currency === "EUR" ? "GBP" : "EUR";
    const lines = reviewText({
      buyer,
      usd: 295,
      extra: [`You'll pay ${money("2.75", third, "en-US")}`],
    });
    expect(judge(read(lines, "en-US"), 295, "USD", true, false).ok).toBe(false);
  });

  test("is held on a store's own checkout", () => {
    const [cop] = BUYERS;
    const lines = reviewText({ buyer: cop as (typeof BUYERS)[number], usd: 295 });
    expect(judge(read(lines, "es-CO"), 295, "USD", false).ok).toBe(false);
  });

  test("pays any amount at any rate, exactly converted, in every buyer's locale and in English", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...BUYERS),
        fc.integer({ min: 100, max: 5_000_000 }),
        fc.integer({ min: 1, max: 99_999_999 }),
        fc.integer({ min: 2, max: 6 }),
        fc.boolean(),
        (b, usd, digits, places, english) => {
          const raw = String(digits).padStart(places + 1, "0");
          const rate = `${raw.slice(0, -places).replace(/^0+(?=\d)/, "")}.${raw.slice(-places)}`;
          // PayPal shows a rate with at most 4 significant decimals past what makes it readable.
          if (Number(rate) < 0.001) return;
          const buyer = { ...b, rate };
          const locale = english ? "en-US" : b.locale;
          const pays = convert(usd, rate, b.shown);
          // Under 100 of its last digit, a doubled order may round to the same amount.
          if (Number(pays) * 10 ** b.shown < 100) return;
          const page = read(reviewText({ buyer, usd, locale }), locale);
          const judged = judge(page, usd, "USD", true, false);
          // A rate written with 3 decimals and a single separator reads two ways, and one with
          // under 4 significant digits rounds too much: held.
          if (page.unsure || String(digits).length < 4) {
            expect(judged.ok).toBe(false);
            return;
          }
          expect(judged, `${rate} ${pays} ${locale}`).toMatchObject({
            ok: true,
            conversion: { currency: b.currency, buyer: pays },
          });
          // Another order total is not this conversion.
          expect(judge(page, usd * 2, "USD", true, false).ok).toBe(false);
        },
      ),
      { numRuns: 3_000 },
    );
  });
});
