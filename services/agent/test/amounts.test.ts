import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { minorDigits, pageLocale, readAmounts, readPage } from "../src/amounts.ts";

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

  test("a number written another locale's way is not read in part", () => {
    expect(readAmounts("Total $2.95 USD", "es-CO", "USD").minor).toEqual([]);
  });

  test("the locale decides 1.234 from 1,234", () => {
    expect(readAmounts("US$1.234", "es-ES", "USD").minor).toEqual([123_400]);
    expect(readAmounts("US$1,234", "en-US", "USD").minor).toEqual([123_400]);
    expect(readAmounts("US$1,23", "en-US", "USD").minor).toEqual([]);
    expect(readAmounts("1,23 US$", "es-ES", "USD").minor).toEqual([123]);
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

describe("what the gate cannot read for sure, it reports as unsure", () => {
  const unsure = (text: string, locales: string[], currency = "USD") =>
    readPage(text, locales, currency).unsure;

  test.each([
    [
      "a space-grouped total in a comma-grouped locale",
      "Subtotal 15.00 USD\nTotal 1 015.00 USD",
      "en",
    ],
    ["a space-grouped euro total", "1 015,00 €", "de"],
    ["a dollar total grouped with a space", "$1 015.00", "en"],
    ["another dollar's symbol", "Total A$12.00", "en"],
    ["Canadian and Mexican dollars", "CA$12.00 · MX$12.00", "en"],
    ["a dollar amount named in another code", "Total $12.00 AUD", "en"],
    ["a number written another locale's way", "Total: 15.00 USD — 1.015,00 USD", "en"],
    ["cents set apart on the next line", "Total $15\n99", "en"],
  ])("%s", (_, text, locale) => {
    expect(unsure(text, [locale])).toBeDefined();
  });

  test("the currency's own code next to a peso symbol is another currency for MXN", () => {
    expect(unsure("Total $15.00 USD", ["es-MX"], "MXN")).toBeDefined();
  });

  test("a tax abbreviation before an amount labels it; three capitals no tax uses still hold", () => {
    expect(readPage("Item $2.95 VAT $0.18 Total $3.13", ["en"], "USD")).toMatchObject({
      minor: [295, 18, 313],
      labels: ["Item", "VAT", "Total"],
    });
    expect(readPage("Total 3,13 US$ IVA 0,18 US$", ["es"], "USD").unsure).toBeUndefined();
    expect(readPage("Total 3,13 € TVA 0,18 €", ["fr"], "EUR").unsure).toBeUndefined();
    expect(readPage("Item $2.95 Total RMB 1,015.00", ["en"], "USD").unsure).toBeDefined();
    expect(readPage("Item $2.95 VAT 1,015.00", ["en"], "USD").unsure).toBeDefined();
  });

  test("USDC is not the code of USD", () => {
    expect(readPage("Total $2.95 · USDC", ["es-CO"], "USD").minor).toEqual([]);
  });

  test("a clean page is sure, in each of its locales", () => {
    expect(readPage("Subtotal US$2,95\nTotal 2,95 US$", ["es"], "USD")).toEqual({
      locale: "es",
      minor: [295, 295],
      labels: ["Subtotal", "Total"],
    });
    expect(readPage("Total ¥1,500", ["ja"], "JPY").minor).toEqual([1500]);
    expect(readPage("Total ￥1,500", ["ja"], "JPY").minor).toEqual([1500]);
  });

  test("two locales the page names that read it differently are unsure", () => {
    expect(readPage("Total US$1.234", ["en", "es"], "USD").unsure).toBeDefined();
    expect(readPage("Total US$2,95", ["es", "es-ES"], "USD")).toEqual({
      locale: "es",
      minor: [295],
      labels: ["Total"],
    });
  });
});

describe("a larger total the reader cannot place makes the page unsure", () => {
  const unsure = (text: string, locale: string, currency = "USD") =>
    readPage(text, [locale], currency).unsure;

  test.each([
    ["Arabic-Indic digits in an English page", "Item $15.00 Total $١٬٠١٥٫٠٠", "en"],
    ["Devanagari digits in a page Intl formats with Latin ones", "वस्तु ₹15.00 कुल ₹१,०१५.००", "hi"],
    ["a total in words", "Item $15.00 Total: 1,015.00 dollars", "en"],
    ["a total under a currency header", "Item $15.00\nOrder total (USD)\n1,015.00", "en"],
    ["a total with a lowercase code", "Item $15.00 Total usd 1,015.00", "en"],
    ["a total behind a dash", "Item $15.00 Total: $  —  1,015.00", "en"],
    ["rupees written Rs.", "Item ₹15.00 Total Rs. 1,015.00", "en-IN", "INR"],
    ["francs written Fr.", "CHF 15.00 Total Fr. 1’015.00", "de-CH", "CHF"],
    ["a total in zloty on a dollar page", "Item $15.00 Total: 1 015,00 zł", "en"],
  ])("%s", (_, text, locale, currency = "USD") => {
    expect(unsure(text, locale, currency)).toBeDefined();
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
    expect(readPage("合計 1,500円", ["ja"], "JPY")).toEqual({
      locale: "ja",
      minor: [1500],
      labels: ["合計"],
    });
    expect(readPage("商品 ¥1,500 合計 101,500 円（税込）", ["ja"], "JPY").minor).toContain(101_500);
  });
});
