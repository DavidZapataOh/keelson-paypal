import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { charges, minorDigits, pageLocale, readAmounts, readPage, values } from "../src/amounts.ts";

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
          const read = readAmounts(shown, locale, currency).minor;
          expect(read, `${locale} ${shown}`).toContain(minor);
          expect(Math.max(...read), `${locale} ${shown}`).toBe(minor);
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

  test("only 3 minor digits make 1.234 two numbers; the page's decimal decides", () => {
    expect(values("1.234", 3)).toEqual([1234, 1_234_000]);
    expect(readAmounts("KWD 1.234", "en-US", "KWD").minor).toEqual([1234]);
    expect(readAmounts("KWD 1.234", "de-DE", "KWD").minor).toEqual([1_234_000]);
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
          // 1.234 of a currency with 3 minor digits, where the locale's decimal is unclear, holds.
          if (digits === 3) expect(read.every((r) => r >= minor)).toBe(true);
          else expect(read, `${locale} ${n}`).toEqual([minor]);
        },
      ),
      { numRuns: 20_000 },
    );
  });

  test("currencies keep their own minor units", () => {
    expect(readAmounts("￥1,234", "ja-JP", "JPY").minor).toEqual([1234]);
    expect(readAmounts("KWD 1.234", "en-US", "KWD").minor).toEqual([1234]);
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
    charges(readPage(text, locales, currency), minor);

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
      loose: [],
    });
    expect(pays("Total ¥1,500", ["ja"], 1500, "JPY")).toBe(true);
    expect(pays("Total ￥1,500", ["ja"], 1500, "JPY")).toBe(true);
  });

  test("two locales the page names that read it differently are unsure", () => {
    expect(readPage("Total KWD 1.234", ["en", "de"], "KWD").unsure).toBeDefined();
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
    expect(charges(readPage("Total $2.95 USD €5.00 USD", ["en"], "USD"), 295)).toBe(false);
    expect(charges(readPage("Total US$2.95 · US$5.00 COP", ["en"], "USD"), 295)).toBe(false);
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
  const review = (o: { usd: number; cop: number; balance: number; total: string }) => {
    const usd = (m: number) => `$${(m / 100).toFixed(2)} USD`;
    const cop = (n: number) =>
      `$${new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 }).format(n)} COP`;
    const rate = new Intl.NumberFormat("es-CO").format(o.cop / (o.usd / 100));
    return [
      `Revisar pedido ${usd(o.usd)}`,
      `The Change ${usd(o.usd)}`,
      `Envío ${usd(0)}`,
      `Total ${o.total}`,
      `Saldo de PayPal ${cop(o.balance)}`,
      `Tasa de conversión de PayPal: 1 USD = ${rate} COP`,
      `Pagarás ${cop(o.cop)}`,
      "Ver opciones de conversión",
    ].join("\n");
  };
  const usdTotal = (minor: number) => `$${(minor / 100).toFixed(2)} USD`;
  const page = fc.record({
    usd: fc.integer({ min: 1, max: 1_000_000 }),
    cop: fc.integer({ min: 1, max: 9_000_000_000 }),
    balance: fc.integer({ min: 0, max: 9_000_000_000 }),
    locale: fc.constantFrom("es", "es-CO", "es-419", "es-MX", "en", "en-US", "pt-BR"),
  });

  test("pays exactly the countersigned USD total, whatever the COP amounts", () => {
    fc.assert(
      fc.property(page, (o) => {
        const text = review({ ...o, total: usdTotal(o.usd) });
        const read = readPage(text, [o.locale], "USD");
        expect(charges(read, o.usd), text).toBe(true);
        expect(charges(read, o.usd + 1), text).toBe(false);
        if (o.usd > 1) expect(charges(read, o.usd - 1), text).toBe(false);
      }),
      { numRuns: 5_000 },
    );
  });

  test("holds when the total is only in COP, or a larger USD amount shows", () => {
    fc.assert(
      fc.property(page, fc.integer({ min: 1, max: 1_000_000 }), (o, more) => {
        const onlyCop = review({ ...o, total: `$${o.cop} COP` });
        expect(charges(readPage(onlyCop, [o.locale], "USD"), o.usd), onlyCop).toBe(false);
        const larger = `${review({ ...o, total: usdTotal(o.usd) })}\nCargo ${usdTotal(o.usd + more)}`;
        expect(charges(readPage(larger, [o.locale], "USD"), o.usd), larger).toBe(false);
      }),
      { numRuns: 5_000 },
    );
  });
});
