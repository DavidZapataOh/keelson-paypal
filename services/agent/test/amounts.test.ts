import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  charges,
  judge,
  judgeQuoted,
  minorDigits,
  pageLocale,
  readAmounts,
  readPage,
  scan,
  values,
  withinQuote,
} from "../src/amounts.ts";
import { ES_CO_CARD_CONVERSION, ES_CO_CARD_REVIEW } from "./fixtures/paypal-pages.ts";

/** Every language ICU formats numbers for, with the regions and numbering systems that change how. */
function locales(): string[] {
  const names = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const languages: string[] = [];
  for (const a of letters) {
    for (const b of letters) {
      const code = `${a}${b}`;
      if (names.of(code) && Intl.NumberFormat.supportedLocalesOf(code).length) languages.push(code);
    }
  }
  const regional = [
    "en-US",
    "en-GB",
    "en-IN",
    "en-CA",
    "en-CH",
    "en-ZA",
    "de-DE",
    "de-CH",
    "de-AT",
    "fr-FR",
    "fr-CA",
    "fr-CH",
    "es-ES",
    "es-MX",
    "es-CO",
    "es-AR",
    "pt-BR",
    "pt-PT",
    "it-IT",
    "it-CH",
    "nl-NL",
    "nl-BE",
    "ja-JP",
    "zh-CN",
    "zh-TW",
    "zh-HK",
    "ko-KR",
    "ar-EG",
    "ar-SA",
    "ar-AE",
    "ar-MA",
    "fa-IR",
    "hi-IN",
    "bn-BD",
    "bn-IN",
    "mr-IN",
    "ne-NP",
    "ur-PK",
    "th-TH",
    "my-MM",
    "ru-RU",
    "uk-UA",
    "pl-PL",
    "tr-TR",
    "he-IL",
    "id-ID",
    "vi-VN",
    "sv-SE",
    "nb-NO",
    "da-DK",
  ];
  const numbering = [
    "ar-EG-u-nu-arab",
    "fa-IR-u-nu-arabext",
    "hi-IN-u-nu-deva",
    "bn-BD-u-nu-beng",
    "th-TH-u-nu-thai",
    "mr-IN-u-nu-deva",
    "my-MM-u-nu-mymr",
    "en-US-u-nu-fullwide",
  ];
  return [...new Set([...languages, ...regional, ...numbering])];
}

const LOCALES = locales();
const CURRENCIES = ["USD", "EUR", "JPY", "KWD", "BRL", "INR", "EGP", "GBP", "CHF", "MXN"];

describe("reading amounts in any locale", () => {
  test("covers the ICU languages and the numbering systems that change digits", () => {
    expect(LOCALES.length).toBeGreaterThan(150);
  });

  test("every locale reads back, to the minor unit, what it formats in each currency", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LOCALES),
        fc.constantFrom(...CURRENCIES),
        fc.integer({ min: 0, max: 99_999_999 }),
        fc.constantFrom("symbol", "code", "narrowSymbol"),
        (locale, currency, minor, display) => {
          const digits = minorDigits(currency);
          const text = new Intl.NumberFormat(locale, {
            style: "currency",
            currency,
            currencyDisplay: display as "symbol",
          }).format(minor / 10 ** digits);
          // The narrow symbol is read only next to the ISO code, as checkouts write "$2.95 USD".
          const shown = display === "narrowSymbol" ? `${text} ${currency}` : `Total ${text}`;
          const page = readPage(shown, [locale], currency);
          // 1.234 of a currency with 3 minor digits reads two ways: the page is held.
          if (page.unsure === "an amount read two ways" && digits === 3) return;
          expect(page.unsure, `${locale} ${shown}`).toBeUndefined();
          expect(page.minor, `${locale} ${shown}`).toEqual([minor]);
        },
      ),
      { numRuns: 20_000 },
    );
  });

  test("an amount in another currency does not count", () => {
    for (const locale of ["en-US", "es-CO", "de-DE", "ja-JP", "ar-EG"]) {
      const eur = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }).format(9.5);
      expect(readAmounts(`Total ${eur}`, locale, "USD").minor, locale).toEqual([]);
    }
    // In Canada "$" is the Canadian dollar; a US dollar amount is written US$.
    expect(readAmounts("Total $2.95", "en-CA", "USD").minor).toEqual([]);
    expect(readAmounts("Total US$2.95", "en-CA", "USD").minor).toEqual([295]);
  });

  test("a bare narrow symbol is not read without the currency's code on the page", () => {
    expect(readAmounts("Total $2,95", "es-CO", "USD").minor).toEqual([]);
    expect(readAmounts("Total $2,95 USD", "es-CO", "USD").minor).toEqual([295]);
    expect(readAmounts("Total $2.95 USD", "en-US", "USD").minor).toEqual([295]);
  });

  test("a number's separators are read by its shape, as PayPal mixes them on one page", () => {
    expect(readAmounts("Total $2.95 USD", "es-CO", "USD").minor).toEqual([295]);
    expect(readAmounts("Total $2,95 USD", "en-US", "USD").minor).toEqual([295]);
    expect(readAmounts("US$1.234", "es-ES", "USD").minor).toEqual([123_400]);
    expect(readAmounts("US$1,234", "en-US", "USD").minor).toEqual([123_400]);
    expect(readAmounts("US$1,23", "en-US", "USD").minor).toEqual([123]);
    expect(readAmounts("USD 3,500.00 · 2,50 USD", "es-CO", "USD").minor).toEqual([350_000, 250]);
  });

  test("only 3 minor digits make 1.234 two numbers, and the page is then unsure", () => {
    expect(values("1.234", 3)).toEqual([1234, 1_234_000]);
    expect(readPage("Total KWD 1.234", ["en-US"], "KWD").unsure).toBeDefined();
    expect(readPage("Total KWD 1,234.567", ["en-US"], "KWD").minor).toEqual([1_234_567]);
  });

  test("no locale writes these, so they are no number", () => {
    for (const run of ["2.9", "15 99", "1.000.000,5", "1,2,3", "1.234,567", "1.2345"]) {
      expect(values(run, 2), run).toEqual([]);
    }
  });

  test("whatever a number's shape, a currency with 0 or 2 minor digits reads it one way at most", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^\d{1,4}(?:[.,' ]\d{1,4}){0,4}$/),
        fc.constantFrom(0, 2),
        (run, fraction) => {
          expect(values(run, fraction).length).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 20_000 },
    );
  });

  test("a group never reads as cents nor cents as a group, so no amount reads smaller", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LOCALES),
        fc.constantFrom(...CURRENCIES),
        fc.integer({ min: 0, max: 99_999_999 }),
        (locale, currency, minor) => {
          const digits = minorDigits(currency);
          const n = new Intl.NumberFormat(locale, {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
          }).format(minor / 10 ** digits);
          const read = readAmounts(`Total ${n} ${currency}`, locale, currency).minor;
          // 1.234 of a currency with 3 minor digits reads two ways: never one smaller than written.
          if (digits === 3) expect(read.every((r) => r >= minor)).toBe(true);
          else expect(read, `${locale} ${n}`).toEqual([minor]);
        },
      ),
      { numRuns: 20_000 },
    );
  });

  test("currencies keep their own minor units", () => {
    expect(readAmounts("￥1,234", "ja-JP", "JPY").minor).toEqual([1234]);
    expect(readAmounts("KWD 12.345", "en-US", "KWD").minor).toEqual([]);
    expect(readAmounts("₹12,34,567.00", "en-IN", "INR").minor).toEqual([123_456_700]);
  });

  test("a number with no currency mark is not an amount", () => {
    expect(readAmounts("Pedido 2,95 · 3 artículos · 2026", "es-ES", "USD").minor).toEqual([]);
  });
});

describe("the page's locale", () => {
  test("is its html lang, else PayPal's locale.x; none or an unknown one is undefined", () => {
    expect(pageLocale("es", "https://www.paypal.com/pay")).toBe("es");
    expect(pageLocale("", "https://www.paypal.com/checkoutnow?locale.x=de_DE")).toBe("de-DE");
    expect(pageLocale("pt-BR", "https://x.example/?locale.x=en_US")).toBe("pt-BR");
    expect(pageLocale("", "https://www.alfred.com/cart")).toBeUndefined();
    expect(pageLocale("not a tag!", "https://x.example/")).toBeUndefined();
    expect(pageLocale("en_US", "https://x.example/")).toBe("en-US");
  });
});

describe("a page is paid only where it charges the countersigned total and nothing more", () => {
  const pays = (text: string, locales: string[], minor: number, currency = "USD") =>
    charges(readPage(text, locales, currency), minor, currency);

  test.each([
    ["a space-grouped total", "Subtotal 15.00 USD\nTotal 1 015.00 USD", "en"],
    ["a space-grouped euro total", "Artikel 15,00 € Gesamt 1 015,00 €", "de", "EUR"],
    ["a dollar total grouped with a space", "Item $15.00 Total $1 015.00", "en"],
    ["another dollar's symbol", "Item $15.00 Total A$15.00", "en"],
    ["Canadian and Mexican dollars", "Total CA$15.00 · MX$15.00", "en"],
    ["a dollar amount named in another code", "Total $15.00 AUD", "en"],
    ["a number written another locale's way", "Total: 15.00 USD — 1.015,00 USD", "en"],
    ["cents set apart on the next line", "Total $15\n99", "en"],
    ["a total in another currency only", "Item $15.00 USD Total $51.231 COP", "es"],
    ["a total in RMB, which is no ISO code", "Item $15.00 Total RMB 1,015.00", "en"],
    ["a larger amount labeled as tax", "Item $15.00 VAT 1,015.00 Total $15.00", "en"],
    ["the total labeled nowhere", "Item $15.00 USD", "en"],
    ["a larger amount in a row of its own", "Total $15.00 USD Fee $1,015.00 USD", "en"],
  ])("%s is held", (_, text, locale, currency = "USD") => {
    expect(pays(text, [locale], 1500, currency)).toBe(false);
  });

  test("the currency's own code next to a peso symbol is another currency for MXN", () => {
    expect(pays("Total $15.00 USD", ["es-MX"], 1500, "MXN")).toBe(false);
    expect(pays("Total $15.00 MXN", ["es-MX"], 1500, "MXN")).toBe(true);
  });

  test("a tax abbreviation before an amount labels it", () => {
    expect(readPage("Item $2.95 VAT $0.18 Total $3.13", ["en"], "USD")).toMatchObject({
      minor: [295, 18, 313],
      labels: ["Item", "VAT", "Total"],
      totals: [313],
    });
    expect(pays("Total 3,13 US$ IVA 0,18 US$", ["es"], 313)).toBe(true);
    expect(pays("Total 3,13 € TVA 0,18 €", ["fr"], 313, "EUR")).toBe(true);
  });

  test("USDC is not the code of USD", () => {
    expect(readPage("Total $2.95 · USDC", ["es-CO"], "USD").minor).toEqual([]);
  });

  test("a clean page is sure, in each of its locales", () => {
    expect(readPage("Subtotal US$2,95\nTotal 2,95 US$", ["es"], "USD")).toEqual({
      locale: "es",
      minor: [295, 295],
      labels: ["Subtotal", "Total"],
      totals: [295],
      offers: [],
      loose: [],
      shared: [],
      conversions: [],
      rates: {},
      inverse: {},
    });
    expect(pays("Total ¥1,500", ["ja"], 1500, "JPY")).toBe(true);
    expect(pays("Total ￥1,500", ["ja"], 1500, "JPY")).toBe(true);
  });

  test("two locales the page names that read it differently are unsure", () => {
    expect(readPage("Total KWD 1.234", ["en", "de"], "KWD").unsure).toBeDefined();
    expect(readPage("Total US$2,95 · Fee USD 1.5", ["en", "en-GB"], "USD").unsure).toBeDefined();
    expect(pays("Total US$2,95", ["es", "es-ES"], 295)).toBe(true);
  });

  test.each([
    ["Arabic-Indic digits in an English page", "Item $15.00 Total $١٬٠١٥٫٠٠", "en"],
    [
      "Devanagari digits in a page Intl formats with Latin ones",
      "वस्तु ₹15.00 कुल ₹१,०१५.००",
      "hi",
      "INR",
    ],
    ["a total in words", "Item $15.00 Total: 1,015.00 dollars", "en"],
    [
      "a total under a currency header",
      "Item $15.00 Total $15.00\nOrder total (USD)\n1,015.00",
      "en",
    ],
    ["a total with a lowercase code", "Item $15.00 Total $15.00 usd 1,015.00", "en"],
    ["a total behind a dash", "Total $15.00 Total: $  —  1,015.00", "en"],
    ["rupees written Rs.", "Item ₹15.00 Total ₹15.00 Rs. 1,015.00", "en-IN", "INR"],
    ["francs written Fr.", "Total CHF 15.00 Total Fr. 1’015.00", "de-CH", "CHF"],
    ["a total in zloty on a dollar page", "Total $15.00 Total: 1 015,00 zł", "en"],
    ["a dollar sign COP shares", "Total $15.00 USD Pagarás $1.015 · 1 USD = 3.468 COP", "es"],
  ])("a larger total the reader cannot place holds: %s", (_, text, locale, currency = "USD") => {
    expect(pays(text, [locale], 1500, currency)).toBe(false);
  });

  test.each([
    ["a zero-width space", "Subtotal $15.00 Total $1\u200b,015.00"],
    ["a word joiner", "Subtotal $15.00 Total $\u20601,015.00"],
    ["a soft hyphen", "Subtotal $15.00 Total $1\u00ad,015.00"],
  ])("a total with %s inside is read whole", (_, text) => {
    expect(readPage(text, ["en"], "USD")).toMatchObject({ locale: "en", minor: [1500, 101_500] });
    expect(readPage(text, ["en"], "USD").unsure).toBeUndefined();
  });

  test("yen written 円 is read as yen, and a larger one is not missed", () => {
    expect(readPage("合計 1,500円", ["ja"], "JPY")).toMatchObject({
      locale: "ja",
      minor: [1500],
      labels: ["合計"],
      totals: [1500],
    });
    expect(readPage("商品 ¥1,500 合計 101,500 円（税込）", ["ja"], "JPY").minor).toContain(101_500);
  });
});

describe("the currency a number's marks name", () => {
  test("two currencies on one number make it uncertain, and a larger one holds", () => {
    expect(charges(readPage("Total $2.95 USD €5.00 USD", ["en"], "USD"), 295, "USD")).toBe(false);
    expect(charges(readPage("Total US$2.95 · US$5.00 COP", ["en"], "USD"), 295, "USD")).toBe(false);
  });

  test("a mark written onto one number is not the next one's", () => {
    expect(readPage("Total $2.95 USD 4242", ["en"], "USD")).toMatchObject({
      minor: [295],
      loose: [],
    });
    expect(readPage("Ref 110221 $2.95 USD", ["en"], "USD")).toMatchObject({ minor: [295] });
  });
});

describe("PayPal's review page for a buyer whose account converts the total", () => {
  /** A synthetic page shaped like PayPal's: USD written "$2.95 USD", COP grouped with a point. */
  const converted = (o: { usd: number; rate: number }) => Math.round((o.usd * o.rate) / 10_000);
  const review = (o: {
    usd: number;
    rate: number;
    balance: number;
    total: string;
    pay?: number;
    rateLine?: boolean;
  }) => {
    const usd = (m: number) => `$${(m / 100).toFixed(2)} USD`;
    const cop = (n: number) =>
      `$${new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 }).format(n)} COP`;
    const rate = new Intl.NumberFormat("es-CO", { minimumFractionDigits: 2 }).format(o.rate / 100);
    return [
      `Revisar pedido ${usd(o.usd)}`,
      `The Change ${usd(o.usd)}`,
      `Envío ${usd(0)}`,
      `Total ${o.total}`,
      `Saldo de PayPal ${cop(o.balance)}`,
      o.rateLine === false ? "" : `Tasa de conversión de PayPal: 1 USD = ${rate} COP`,
      `Pagarás ${cop(o.pay ?? converted(o))}`,
      "Ver opciones de conversión",
    ].join("\n");
  };
  const usdTotal = (minor: number) => `$${(minor / 100).toFixed(2)} USD`;
  const page = fc.record({
    // A total under one unit holds where a rate shows: its unit is set aside.
    usd: fc.integer({ min: 100, max: 1_000_000 }),
    /** COP per USD, in hundredths: 10.00 to 10,000.00, with the 4 significant digits PayPal shows. */
    rate: fc.integer({ min: 1000, max: 1_000_000 }),
    balance: fc.integer({ min: 0, max: 9_000_000_000 }),
    locale: fc.constantFrom("es", "es-CO", "es-419", "es-MX", "en", "en-US", "pt-BR"),
  });

  test("pays exactly the countersigned USD total, converted at the rate the page writes", () => {
    fc.assert(
      fc.property(page, (o) => {
        const text = review({ ...o, total: usdTotal(o.usd) });
        const read = readPage(text, [o.locale], "USD");
        expect(charges(read, o.usd, "USD", true), text).toBe(true);
        expect(charges(read, o.usd + 1, "USD", true), text).toBe(false);
        if (o.usd > 1) expect(charges(read, o.usd - 1, "USD", true), text).toBe(false);
      }),
      { numRuns: 5_000 },
    );
  });

  test("pays a total labeled only in COP that is the USD total at the page's rate", () => {
    fc.assert(
      fc.property(page, (o) => {
        const cop = (n: number) =>
          `$${new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 }).format(n)} COP`;
        const onlyCop = review({ ...o, total: cop(converted(o)) });
        const read = readPage(onlyCop, [o.locale], "USD");
        expect(charges(read, o.usd, "USD", true), onlyCop).toBe(true);
        expect(charges(read, o.usd, "USD", false), onlyCop).toBe(false);
        // Off by more than a peso and the rate's rounding: another total.
        const off = Math.ceil((o.usd / 100) * 0.005) + 2;
        const wrong = review({ ...o, total: cop(converted(o) + off), pay: converted(o) + off });
        expect(charges(readPage(wrong, [o.locale], "USD"), o.usd, "USD", true), wrong).toBe(false);
      }),
      { numRuns: 5_000 },
    );
  });

  test("holds when a COP charge is off the rate, no rate shows, or a larger USD amount shows", () => {
    fc.assert(
      fc.property(page, fc.integer({ min: 1, max: 1_000_000 }), (o, more) => {
        // A converted charge the rate does not account for, or no rate to check it against.
        const off = review({ ...o, total: usdTotal(o.usd), pay: converted(o) * 2 + 2 });
        expect(charges(readPage(off, [o.locale], "USD"), o.usd, "USD", true), off).toBe(false);
        const unrated = review({ ...o, total: usdTotal(o.usd), rateLine: false });
        expect(charges(readPage(unrated, [o.locale], "USD"), o.usd, "USD", true), unrated).toBe(
          false,
        );
        const larger = `${review({ ...o, total: usdTotal(o.usd) })}\nCargo ${usdTotal(o.usd + more)}`;
        expect(charges(readPage(larger, [o.locale], "USD"), o.usd, "USD", true), larger).toBe(
          false,
        );
      }),
      { numRuns: 5_000 },
    );
  });
});

describe("pages an independent review found paid more than the countersigned total", () => {
  test.each([
    ["the currency's code glued to its sign", "Total $10.00 USD\nFee USD$490.00", "en", "USD"],
    [
      "the narrow sign where the locale writes US$",
      "Total US$10.00\nDelivery $490.00",
      "en-GB",
      "USD",
    ],
    ["the narrow sign after the number", "Total US$10.00\nShipping 490.00 $", "en-GB", "USD"],
    ["the peso sign for MXN in English", "Total MX$10.00\nEnvío $490.00", "en", "MXN"],
    ["the yen sign in Chinese", "合计 JP¥1,000\n运费 ¥5,000", "zh-CN", "JPY"],
    [
      "a row after a rate line",
      "Total $10.00 USD\nExchange rate 1 USD = 0.92 EUR\n$490.00 USD",
      "en",
      "USD",
    ],
    [
      "a row after a balance",
      "Total $10.00 USD\nPayPal balance\n$0.00 USD\n$490.00 USD",
      "en",
      "USD",
    ],
    [
      "a row after a balance, before the total",
      "PayPal balance $0.00 USD\n$490.00 USD\nTotal $10.00 USD",
      "en",
      "USD",
    ],
    [
      "a euro row after a balance",
      "Total 10,00 €\nSaldo disponible\n0,00 €\n490,00 €",
      "es",
      "EUR",
    ],
    ["a total in another currency", "Order total $10.00 USD\nGrand total $490.00 AUD", "en", "USD"],
    ["a total in Australian dollars", "Total $10.00\nGrand total A$490.00", "en-US", "USD"],
    ["a balance due", "Total $10.00 USD\nBalance due $490.00 USD", "en", "USD"],
    [
      "a limit in a product name",
      "Total $10.00 USD\nShipping (limit 1 per order) $490.00 USD",
      "en",
      "USD",
    ],
    ["points in a label", "Total $10.00 USD\nYou earn 20 points · $490.00 USD", "en", "USD"],
    ["a number no locale writes", "Total $10.00 USD\nFee 490.0", "en", "USD"],
    ["a number grouped wrongly", "Total $10.00 USD\nFee 4,90.00", "en", "USD"],
    ["a number with one decimal", "Total $10.00 USD\nFee 1.000.000,5", "en", "USD"],
    ["a code that is a word", "Total $10.00 USD\nTOTAL DUE IN TOP 490.00", "en", "USD"],
    ["a code that is a word, before", "Total $10.00\nInsurance PEN 490.00", "en-US", "USD"],
    ["a code that is a word, after", "Total $10.00\nFee 490.00 ALL", "en-US", "USD"],
    ["a fee in euros", "Total $10.00 USD\nFee €490.00", "en", "USD"],
    ["a fee in pounds", "Total $10.00\nFee £490.00", "en-US", "USD"],
    ["an installment the size of the total", "Pay in 4 installments of $10.00", "en", "USD"],
  ])("%s is held", (_, text, locale, currency) => {
    expect(charges(readPage(text, [locale], currency), 1000, currency)).toBe(false);
  });

  test("3 minor digits read two ways hold", () => {
    expect(charges(readPage("Total KWD 1.234", ["en"], "KWD"), 1234, "KWD")).toBe(false);
  });
});

describe("pages a second review found paid more than the countersigned total", () => {
  const pays = (text: string, converts: boolean, locale = "en", currency = "USD") =>
    charges(readPage(text, [locale], currency), 1000, currency, converts);

  test.each([
    ["a total after '=' in another currency", "Total $10.00 USD = 4,900.00 MXN"],
    ["a code before it", "Total $10.00 USD = MXN 4,900.00"],
    ["an item after '='", "Item $10.00 USD = 490.00 AUD\nTotal $10.00 USD"],
    [
      "two rates that disagree",
      "Total $10.00 USD\n1 USD = 17.00 MXN\n1 USD = 490.00 MXN\nTotal 4,900.00 MXN",
    ],
    ["a balance due in another currency", "Total $10.00 USD\nBalance due 490.00 AUD"],
    ["a rupee amount written Rs.", "Total ₹10.00\nShipping Rs. 490", "en-IN", "INR"],
    ["yen written as a word", "合計 ¥1,000\n送料 5000 yen", "ja", "JPY"],
    ["dollars written as a word", "Total $10.00 USD\nShipping 490 dollars"],
    ["cents set apart", "Total $10.00 USD\nFee 490 00"],
  ])("%s is held, on PayPal too", (_, text, locale = "en", currency = "USD") => {
    expect(charges(readPage(text, [locale], currency), 1000, currency, true)).toBe(false);
  });

  test("a store's checkout showing any rate or other currency is held", () => {
    const paypal = "Total $10.00 USD\nTasa: 1 USD = 3.468,14 COP\nPagarás $34.681 COP";
    expect(pays(paypal, true, "es")).toBe(true);
    expect(pays(paypal, false, "es")).toBe(false);
    expect(pays("Total $10.00 USD\nAvailable at checkout: 490.00 CAD", false)).toBe(false);
  });

  test("a code between a card's last digits and the amount names the amount", () => {
    expect(readPage("Visa •••• 4242 USD $10.00\nTotal USD $10.00", ["en"], "USD")).toMatchObject({
      minor: [1000, 1000],
      totals: [1000],
    });
  });
});

describe("pages a final review found paid more than the countersigned total", () => {
  test.each([
    [
      "a whole amount whose code a quantity follows",
      "Total $10.00 USD\nShipping 490 USD 1 item",
      "en",
      "USD",
    ],
    [
      "a whole amount before another amount",
      "Total $10.00 USD\nShipping 490 USD $0.00",
      "en",
      "USD",
    ],
    ["a whole yen amount before a quantity", "合計 ¥1,000\n追加 5000 JPY 2", "ja", "JPY"],
  ])("%s is held", (_, text, locale, currency) => {
    expect(charges(readPage(text, [locale], currency), 1000, currency, true)).toBe(false);
  });

  test("a rate's unit does not hide a total under one unit", () => {
    const text = "Total $0.50 USD\nFee 1 USD = 4,000.00 COP";
    expect(charges(readPage(text, ["en"], "USD"), 50, "USD", true)).toBe(false);
  });

  test("on PayPal, only the buyer's balance in another currency is set aside", () => {
    const rate = "Total $10.00 USD\n1 USD = 17.00 MXN\nPagarás $170.00 MXN";
    expect(
      charges(readPage(`${rate}\nSaldo de PayPal $4,900.00 MXN`, ["es"], "USD"), 1000, "USD", true),
    ).toBe(true);
    expect(
      charges(
        readPage(`${rate}\nRemaining balance $4,900.00 MXN`, ["en"], "USD"),
        1000,
        "USD",
        true,
      ),
    ).toBe(false);
  });

  test("a masked card's last digits before a coded amount are no amount", () => {
    expect(
      charges(readPage("Visa •••• 4242 USD $10.00\nTotal USD $10.00", ["en"], "USD"), 1000, "USD"),
    ).toBe(true);
  });
});

describe("a card's or an account's last digits are never an amount", () => {
  /** How checkouts write the last digits of a funding source, in the languages they offer. */
  const MASKS: readonly ((d: string) => string)[] = [
    (d) => `••${d}`,
    (d) => `•••• ${d}`,
    (d) => `▪ ••${d}`,
    (d) => `**** **** **** ${d}`,
    (d) => `*${d}`,
    (d) => `xxxx${d}`,
    (d) => `XXXX-${d}`,
    (d) => `...${d}`,
    (d) => `ending in ${d}`,
    (d) => `ending with ${d}`,
    (d) => `terminada en ${d}`,
    (d) => `que termina en ${d}`,
    (d) => `se termine par ${d}`,
    (d) => `se terminant par ${d}`,
    (d) => `endet auf ${d}`,
    (d) => `terminado em ${d}`,
    (d) => `com final ${d}`,
    (d) => `eindigend op ${d}`,
    (d) => `che termina con ${d}`,
    (d) => `末尾${d}`,
    (d) => `尾号${d}`,
  ];
  const SOURCES = ["Visa", "Visa Cargo", "Mastercard", "Amex", "Bancolombia", "Banco", "Tarjeta"];
  const PAGE_LOCALES = [
    "en-US",
    "es-CO",
    "es-MX",
    "fr-FR",
    "de-DE",
    "pt-BR",
    "it-IT",
    "nl-NL",
    "ja-JP",
    "zh-CN",
  ];

  test("the es-CO page that held a real purchase reads only PayPal's amounts", () => {
    const text = ES_CO_CARD_REVIEW.join("\n");
    expect(scan(text, "es", "USD").find((t) => t.number === "4821")?.kind).toBe("plain");
    const read = readPage(text, ["es"], "USD");
    expect(read.unsure).toBeUndefined();
    expect(read.minor).toEqual([]);
    const known = { currency: "COP", rate: ES_CO_CARD_CONVERSION.rate };
    expect(judge(read, 295, "USD", true, false, known)).toEqual({ ok: true });
    // With nothing from PayPal itself, the pesos under the sign USD shares may be dollars.
    expect(judge(read, 295, "USD", true, false).ok).toBe(false);
    // A larger amount in pesos, or a rate line off PayPal's, still holds.
    const more = readPage(`${text}\nComisión $ 30.000`, ["es"], "USD");
    expect(judge(more, 295, "USD", true, false, known)).toEqual({
      ok: false,
      reason: "a larger amount in the buyer's currency",
    });
    const off = readPage(text.replace("0,00029", "0,00031"), ["es"], "USD");
    expect(judge(off, 295, "USD", true, false, known)).toEqual({
      ok: false,
      reason: "a rate line that is not PayPal's rate",
    });
  });

  test.each([
    ["Visa •••• 4821 $2.95 USD", "en"],
    ["Visa ending in 4821\n$2.95 USD", "en"],
    ["Mastercard ****4821 US$ 2,95", "es"],
    ["Visa terminada en 4821 US$ 2,95", "es"],
    ["Tarjeta que termina en 4821 2,95 US$", "es"],
    ["Carte Visa se terminant par 4821 2,95 $US", "fr"],
    ["Visa endet auf 4821 2,95 $", "de"],
    ["Cartão com final 4821 US$ 2,95", "pt-BR"],
    ["Amex XXXX-4821 $2.95 USD", "en"],
  ])("%s reads one amount, 2.95", (text, locale) => {
    expect(scan(text, locale, "USD").find((t) => t.number === "4821")?.kind).toBe("plain");
    expect(readPage(text, [locale], "USD")).toMatchObject({ minor: [295], loose: [] });
  });

  test("whatever the source, mask and locale, the digits after a mask are no amount", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SOURCES),
        fc.constantFrom(...MASKS),
        fc.stringMatching(/^\d{2,4}$/),
        fc.constantFrom(...PAGE_LOCALES),
        fc.integer({ min: 1, max: 99_999_999 }),
        fc.constantFrom(" ", "\n", " · "),
        (source, mask, digits, locale, minor, gap) => {
          const amount = new Intl.NumberFormat(locale, {
            style: "currency",
            currency: "USD",
          }).format(minor / 100);
          const text = `${source} ${mask(digits)}${gap}${amount}`;
          const masked = scan(text, locale, "USD").filter((t) => t.number === digits);
          expect(masked.every((t) => t.kind === "plain")).toBe(true);
          const read = readPage(text, [locale], "USD");
          expect(read).toMatchObject({ minor: [minor], loose: [] });
          expect(read.unsure).toBeUndefined();
        },
      ),
      { numRuns: 2_000 },
    );
  });
});

describe("PayPal's rate stated per unit", () => {
  const cop = { currency: "COP", rate: "0.000290145", inverse: true };

  test("bounds a converted total by the mandate's spread and the digits PayPal shows, exactly", () => {
    // 10236 × 0.000290145 / 2.95 = 1.0067540…: 67.54 basis points over PayPal's rate.
    expect(withinQuote("2.95", "10236", cop, 68)).toBe(true);
    expect(withinQuote("2.95", "10236", cop, 67)).toBe(false);
    // The rate's last digit rounds: 1 / 0.0002901455 to 1 / 0.0002901445 is 3446.547… to 3446.559….
    expect(withinQuote("1", "3446.55", cop, 0)).toBe(true);
    expect(withinQuote("1", "3446.56", cop, 0)).toBe(false);
    // The same quote stated the other way round.
    expect(
      withinQuote("2.95", "10236", { currency: "COP", rate: "3446.55", inverse: false }, 68),
    ).toBe(true);
    expect(
      withinQuote("2.95", "10236", { currency: "COP", rate: "3446.55", inverse: false }, 67),
    ).toBe(false);
  });

  test("reads the es-CO page's converted total and holds what it cannot tie to PayPal's rate", () => {
    const page = (text: string) => readPage(text, ["es"], "USD");
    const text = ES_CO_CARD_REVIEW.join("\n");
    expect(judgeQuoted(page(text), 295, "USD", cop, 750)).toEqual({
      ok: true,
      conversion: { currency: "COP", rate: "3469.830508", buyer: "10236", locale: "es" },
    });
    const reason = (t: string, capBps = 750) => {
      const j = judgeQuoted(page(t), 295, "USD", cop, capBps);
      return j.ok ? undefined : j.reason;
    };
    expect(reason(text, 67)).toBe(
      "a converted total off PayPal's rate by more than the mandate's spread",
    );
    expect(reason(text.replace("0,00029", "0,00031"))).toBe(
      "a rate line that is not PayPal's rate",
    );
    expect(reason(`${text}\nComisión $ 30.000`)).toBe("converted totals that disagree");
    expect(reason(`${text}\nTotal $2.95 USD\nEnvío $5.00 USD`)).toBe(
      "a larger amount that may be charged",
    );
    expect(reason("Tipo de cambio de PayPal: 1 COP = 0,00029 USD")).toBe(
      "no converted total shown",
    );
    expect(reason(`${text}\nR$ 17,18 BRL`)).toBe("an amount in a third currency");
  });
});
