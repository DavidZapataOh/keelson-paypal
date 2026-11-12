import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { decimalText, judge, rateBetween, readPage } from "../src/amounts.ts";
import { BUYERS, convert, money, reviewText } from "./fixtures/paypal-pages.ts";

const read = (lines: string[], locale: string) => readPage(lines.join("\n"), [locale], "USD");
/** PayPal's own conversion of `usd` cents at `rate`, as its funding data states it. */
const known = (b: { currency: string; rate: string; shown: number }, usd = 295) => ({
  currency: b.currency,
  rate: rateBetween(decimalText(usd, 2), convert(usd, b.rate, b.shown)),
  quote: { currency: b.currency, rate: b.rate, inverse: false },
});

describe("a PayPal review page that converts a USD order", () => {
  test.each(BUYERS)(
    "to $currency in $locale agrees with PayPal's own conversion, and never pays on its text alone",
    (buyer) => {
      for (const locale of [buyer.locale, "en-US"]) {
        const page = read(reviewText({ buyer, usd: 295 }), locale);
        expect(
          judge(page, 295, "USD", true, false, known(buyer)),
          `${buyer.currency} ${locale}`,
        ).toEqual({ ok: true });
        expect(judge(page, 295, "USD", true, false)).toEqual({
          ok: false,
          reason: "a conversion PayPal's funding data does not state",
        });
      }
    },
  );

  test.each(BUYERS)("to $currency is held for a wrong rate", (buyer) => {
    const lines = reviewText({ buyer, usd: 295, rate: (Number(buyer.rate) * 1.01).toFixed(4) });
    expect(judge(read(lines, buyer.locale), 295, "USD", true, false, known(buyer)).ok).toBe(false);
  });

  test.each(BUYERS)("to $currency needs no rate line on PayPal's own conversion", (buyer) => {
    const lines = reviewText({ buyer, usd: 295, rate: null });
    expect(judge(read(lines, buyer.locale), 295, "USD", true, false, known(buyer)).ok).toBe(true);
    expect(judge(read(lines, buyer.locale), 295, "USD", true, false).ok).toBe(false);
  });

  test.each(BUYERS)("to $currency is held for rates that disagree", (buyer) => {
    const other = (Number(buyer.rate) * 1.02).toFixed(4);
    const lines = reviewText({ buyer, usd: 295, extra: [`1 USD = ${other} ${buyer.currency}`] });
    expect(judge(read(lines, "en-US"), 295, "USD", true, false, known(buyer))).toMatchObject({
      ok: false,
    });
  });

  test.each(BUYERS)("to $currency is held for a larger hidden amount, in either currency", (b) => {
    const usd = reviewText({ buyer: b, usd: 295, extra: ["Fee $5.00 USD"] });
    expect(judge(read(usd, "en-US"), 295, "USD", true, false, known(b)).ok).toBe(false);
    const big = convert(2_950, b.rate, b.shown);
    const local = reviewText({
      buyer: b,
      usd: 295,
      extra: [`Fee ${money(big, b.currency, "en-US")}`],
    });
    expect(judge(read(local, "en-US"), 295, "USD", true, false, known(b)).ok).toBe(false);
  });

  test.each(BUYERS)("to $currency is held when it charges a third currency", (buyer) => {
    const third = buyer.currency === "EUR" ? "GBP" : "EUR";
    const lines = reviewText({
      buyer,
      usd: 295,
      extra: [`You'll pay ${money("2.75", third, "en-US")}`],
    });
    expect(judge(read(lines, "en-US"), 295, "USD", true, false, known(buyer)).ok).toBe(false);
  });

  test("is held on a store's own checkout", () => {
    const [cop] = BUYERS;
    const lines = reviewText({ buyer: cop as (typeof BUYERS)[number], usd: 295 });
    expect(
      judge(read(lines, "es-CO"), 295, "USD", false, true, known(cop as (typeof BUYERS)[number]))
        .ok,
    ).toBe(false);
  });

  test("agrees with PayPal's conversion of any amount at any rate, in every buyer's locale and in English", () => {
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
          const paypal = known(buyer, usd);
          const judged = judge(page, usd, "USD", true, false, paypal);
          // A rate written with 3 decimals and a single separator reads two ways: held.
          if (page.unsure) {
            expect(judged.ok).toBe(false);
            return;
          }
          expect(judged, `${rate} ${pays} ${locale}`).toEqual({ ok: true });
          // Another order total is not this conversion.
          expect(judge(page, usd * 2, "USD", true, false, paypal).ok).toBe(false);
        },
      ),
      { numRuns: 3_000 },
    );
  });
});

describe("PayPal's review page in English, as the sandbox shows it", () => {
  // The rows of the sandbox's review page for a USD buyer, with the buyer's details left out.
  const page = [
    "$2.95",
    "Pay with",
    "Checking ••••0000",
    "$2.95",
    "Pay in 4",
    "4 interest-free payments on eligible purchases of $10.00-$2,000.00. Not available for this transaction.",
    "Pay Monthly",
    "Pay over time for eligible purchases of $49.00-$10,000.00. Not available for this transaction.",
    "Complete Purchase",
  ].join("\n");

  test("its credit offers are no charge where PayPal's order states it, and a charge elsewhere", () => {
    const read = readPage(page, ["en"], "USD");
    expect(read.offers).toEqual([1000, 200000, 4900, 1000000]);
    expect(judge(read, 295, "USD", true, false).ok).toBe(true);
    expect(judge(read, 295, "USD", false).ok).toBe(false);
    expect(judge(readPage(`${page}\nFee $20.00`, ["en"], "USD"), 295, "USD", true, false).ok).toBe(
      false,
    );
  });
});

describe("PayPal's hosted checkout for a EUR order funded in USD, as the sandbox shows it", () => {
  // The rows of the sandbox's signed-in review page, with the buyer's details left out.
  const page = [
    "€2.95",
    "Pay with",
    "Checking",
    " ••••0001",
    "$3.40",
    "Make this my preferred way to pay",
    "PayPal's conversion rate: 1 USD = 0.86645 EUR",
    "Visa",
    "Credit",
    " ••••4242",
    "Pay Later",
    "Pay in 4",
    "4 interest-free payments on eligible purchases of $10.00-$2,000.00. Not available for this transaction.",
    "Pay Monthly",
    "Pay over time for eligible purchases of $49.00-$10,000.00. Not available for this transaction.",
    "PayPal Credit",
    "Pay over time for your purchase of $3.40 with PayPal Credit. Subject to credit approval. See terms",
    "Complete Purchase",
  ].join("\n");
  // PayPal charges USD 3.40 and shows 1 USD = 0.866445367 EUR.
  const known = {
    currency: "USD",
    rate: rateBetween("2.95", "3.40"),
    quote: { currency: "USD", rate: "0.866445367", inverse: true },
  };

  test("its credit offers' ranges in USD are no charge; a larger USD amount is", () => {
    const read = readPage(page, ["en"], "EUR");
    expect(judge(read, 295, "EUR", true, false, known)).toEqual({ ok: true });
    const fee = readPage(`${page}\nFee $5.00`, ["en"], "EUR");
    expect(judge(fee, 295, "EUR", true, false, known)).toEqual({
      ok: false,
      reason: "a larger amount in the buyer's currency",
    });
  });
});
