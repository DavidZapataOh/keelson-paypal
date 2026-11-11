import { checkoutTotal } from "@keelson/core";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { minorDigits, readPage } from "../src/amounts.ts";
import { partOf, requote } from "../src/requote.ts";

const base = checkoutTotal("USD", { items: 295 });
const page = (text: string, locale = "en", currency = "USD") => readPage(text, [locale], currency);

describe("what a checkout labels an amount", () => {
  test.each([
    ["Estimated taxes", "tax"],
    ["Sales tax", "tax"],
    ["VAT", "tax"],
    ["Impuestos", "tax"],
    ["IVA", "tax"],
    ["TVA", "tax"],
    ["MwSt.", "tax"],
    ["消費税", "tax"],
    ["Shipping", "shipping"],
    ["Delivery", "shipping"],
    ["Envío", "shipping"],
    ["Livraison", "shipping"],
    ["Versand", "shipping"],
    ["送料", "shipping"],
    ["Subtotal", undefined],
    ["Total", undefined],
    ["Taxonomy", undefined],
  ])("%s is %s", (label, part) => {
    expect(partOf(label)).toBe(part);
  });

  test("the word nearest the amount decides", () => {
    expect(partOf("Shipping Free Estimated taxes")).toBe("tax");
    expect(partOf("Taxes calculated at checkout Shipping")).toBe("shipping");
  });
});

describe("re-quoting a checkout once its address is known", () => {
  test("adds the tax the page labels when the total is the items plus it", () => {
    expect(requote(base, page("The Change $2.95 Estimated taxes $0.18 Total USD $3.13"))).toEqual(
      checkoutTotal("USD", { items: 295, tax: 18 }),
    );
  });

  test("adds tax and shipping, read in the page's own locale", () => {
    const p = page("Subtotal US$2,95\nEnvío US$5,00\nImpuestos US$0,63\nTotal US$8,58", "es");
    expect(requote(base, p)).toEqual(checkoutTotal("USD", { items: 295, shipping: 500, tax: 63 }));
  });

  test("keeps the countersigned discount", () => {
    const b = checkoutTotal("USD", { items: 1000, discount: 100 });
    const p = page("Subtotal $10.00 Discount $1.00 Shipping $5.00 Sales tax $0.72 Total $14.72");
    expect(requote(b, p)).toEqual(
      checkoutTotal("USD", { items: 1000, discount: 100, shipping: 500, tax: 72 }),
    );
  });

  test("gives nothing when the labeled parts do not make up the total", () => {
    // An extra charge nobody labels.
    expect(requote(base, page("Item $2.95 Tax $0.18 Fee $1.00 Total $4.13"))).toBeUndefined();
    // A total the parts overshoot.
    expect(requote(base, page("Item $2.95 Tax $0.18 Total $3.00"))).toBeUndefined();
    // Two different tax amounts.
    expect(requote(base, page("Item $2.95 Tax $0.18 Tax $0.20 Total $3.33"))).toBeUndefined();
    // A larger total with nothing labeled.
    expect(requote(base, page("Item $2.95 Total $5.90"))).toBeUndefined();
  });

  test("gives nothing for a page it could not read for sure", () => {
    expect(requote(base, page("Item $2.95 Tax $0.18 Total $3.13\n$15\n99"))).toBeUndefined();
  });

  test("a page shown twice, in two frames, counts each part once", () => {
    const text = "Tax $0.18 Total $3.13\nItem total $2.95 Tax $0.18 Total $3.13";
    expect(requote(base, page(text))?.minor).toBe(313);
  });

  test("in any currency and locale, the parts of a written checkout come back exactly", () => {
    const LOCALES = ["en-US", "es", "es-MX", "de-DE", "fr-FR", "pt-BR", "ja", "en-IN", "ar-EG"];
    const CURRENCIES = ["USD", "EUR", "JPY", "BRL", "GBP", "MXN"];
    const LABELS = {
      en: ["Subtotal", "Shipping", "Estimated taxes", "Total"],
      es: ["Subtotal", "Envío", "Impuestos", "Total"],
      de: ["Zwischensumme", "Versand", "MwSt.", "Gesamt"],
      fr: ["Sous-total", "Livraison", "TVA", "Total"],
      pt: ["Subtotal", "Frete", "Impostos", "Total"],
      ja: ["小計", "送料", "消費税", "合計"],
      ar: ["المجموع الفرعي", "الشحن", "الضريبة", "الإجمالي"],
    } as const;
    fc.assert(
      fc.property(
        fc.constantFrom(...LOCALES),
        fc.constantFrom(...CURRENCIES),
        fc.integer({ min: 1, max: 50_000 }),
        fc.integer({ min: 0, max: 5_000 }),
        fc.integer({ min: 0, max: 5_000 }),
        (locale, currency, units, taxUnits, shipUnits) => {
          const digits = minorDigits(currency);
          const [items, tax, shipping] = [units, taxUnits, shipUnits];
          const fmt = new Intl.NumberFormat(locale, { style: "currency", currency });
          const money = (m: number) => fmt.format(m / 10 ** digits);
          const words = LABELS[locale.slice(0, 2) as keyof typeof LABELS];
          const lines = [
            `${words[0]} ${money(items)}`,
            ...(shipping > 0 ? [`${words[1]} ${money(shipping)}`] : []),
            ...(tax > 0 ? [`${words[2]} ${money(tax)}`] : []),
            `${words[3]} ${money(items + tax + shipping)}`,
          ];
          const read = page(lines.join("\n"), locale, currency);
          expect(read.unsure, lines.join(" | ")).toBeUndefined();
          expect(read.totals, lines.join(" | ")).toContain(items + tax + shipping);
          const next = requote(checkoutTotal(currency, { items }), read);
          expect(next, lines.join(" | ")).toEqual(
            checkoutTotal(currency, { items, tax, shipping }),
          );
        },
      ),
      { numRuns: 3_000 },
    );
  });
});
