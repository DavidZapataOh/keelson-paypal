/** An amount in minor units of an ISO 4217 currency: cents of USD, yen of JPY, fils of KWD. */
export interface Money {
  currency: string;
  minor: number;
}

/** What a page shows in one currency, read in the page's own locale. */
export interface PageAmounts {
  locale: string;
  currency: string;
  /** Every amount in `currency`, in its minor units, in page order. */
  minor: number[];
}

/** Every space a number formatter writes (NBSP, narrow NBSP, thin, figure, …), as one space. */
const SPACES = /[\s    ]+/gu;
/** Bidirectional marks right-to-left locales put around numbers and signs. */
const BIDI = /[؜‎‏‪-‮⁦-⁩]/gu;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const flat = (s: string) => s.replace(BIDI, "").replace(SPACES, " ");

/** The minor units of `currency`: 2 for USD, 0 for JPY, 3 for KWD (ISO 4217, as CLDR has them). */
export function minorDigits(currency: string): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
    .maximumFractionDigits as number;
}

/** How `locale` writes amounts of `currency`, read from CLDR through `Intl.NumberFormat`. */
interface Shape {
  /** The locale's digits, 0 to 9. */
  digits: string[];
  group: string;
  decimal: string;
  /** Group sizes: the last group, then every other (3 and 3; 3 and 2 in India). */
  primary: number;
  secondary: number;
  fraction: number;
  /** The marks that name `currency` in this locale: its symbol and its ISO code. */
  marks: string[];
  /** The narrow symbol (`$` for USD), which names the currency only next to its ISO code. */
  narrow: string;
}

const shapes = new Map<string, Shape>();

function shape(locale: string, currency: string): Shape {
  const key = `${locale}|${currency}`;
  const known = shapes.get(key);
  if (known) return known;
  const fraction = minorDigits(currency);
  const format = (display: "symbol" | "code" | "narrowSymbol") =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: display,
      useGrouping: "always",
    });
  const parts = format("symbol").formatToParts(1234567890.5);
  const integers = parts.filter((p) => p.type === "integer").map((p) => flat(p.value));
  const mark = (display: "symbol" | "code" | "narrowSymbol") =>
    flat(
      format(display)
        .formatToParts(1)
        .find((p) => p.type === "currency")?.value ?? "",
    ).trim();
  const plain = new Intl.NumberFormat(locale, { useGrouping: false });
  const digits = [...Array(10).keys()].map((d) => plain.format(d));
  const s: Shape = {
    digits,
    group: flat(parts.find((p) => p.type === "group")?.value ?? ""),
    // Some locales write money with another decimal than plain numbers (fr-CH: 0.01 vs 0,01).
    decimal: flat(
      (
        parts.find((p) => p.type === "decimal") ??
        new Intl.NumberFormat(locale, { minimumFractionDigits: 1 })
          .formatToParts(1.5)
          .find((p) => p.type === "decimal")
      )?.value ?? ".",
    ),
    primary: integers.at(-1)?.length ?? 3,
    secondary:
      integers.length > 2 ? (integers.at(-2)?.length ?? 3) : (integers.at(-1)?.length ?? 3),
    fraction,
    marks: [...new Set([mark("symbol"), mark("code"), currency])].filter(Boolean),
    narrow: mark("narrowSymbol"),
  };
  shapes.set(key, s);
  return s;
}

/**
 * Every amount of `currency` the text writes, read as `locale` writes it: its digits, its decimal
 * and grouping separators and group sizes, its currency marks before or after the number, and
 * any kind of space between them. The narrow symbol (`$`) counts only when the text also names
 * the currency by its ISO code, since it names several currencies. A number with no mark of the
 * currency is not an amount of it.
 */
export function readAmounts(text: string, locale: string, currency: string): PageAmounts {
  const s = shape(locale, currency);
  let t = flat(text);
  s.digits.forEach((d, i) => {
    if (d !== String(i)) t = t.replaceAll(d, String(i));
  });
  const marks = [...s.marks];
  if (s.narrow && !marks.includes(s.narrow) && t.includes(currency)) marks.push(s.narrow);
  const mark = marks
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|");
  const g = escapeRegex(s.group);
  const d = escapeRegex(s.decimal);
  const integer = s.group
    ? `\\d{1,${s.secondary}}(?:${g}\\d{${s.secondary}})*${g}\\d{${s.primary}}|\\d+`
    : "\\d+";
  const number = `(?:${integer})${s.fraction > 0 ? `(?:${d}\\d{${s.fraction}})?` : ""}`;
  // A whole number only: no digit or separator of any locale may run on before or after it, so
  // a number written another way ("2.95" where "," is the decimal) is not read in part.
  const SEPARATORS = ".,'\u2019\u066b\u066c";
  const before = `\\d${escapeRegex(SEPARATORS)}${s.group === " " ? "" : g}`;
  const amount = new RegExp(
    `(?<![${before}])(?:(?:${mark}) ?(${number})|(${number}) ?(?:${mark}))(?![${escapeRegex(SEPARATORS)}${d}]?\\d)`,
    "gu",
  );
  const minor: number[] = [];
  for (const m of t.matchAll(amount)) {
    const written = (m[1] ?? m[2]) as string;
    const [whole = "", cents = ""] = written.split(s.decimal);
    const units = Number(s.group ? whole.replaceAll(s.group, "") : whole);
    minor.push(units * 10 ** s.fraction + Number(cents.padEnd(s.fraction, "0") || 0));
  }
  return { locale, currency, minor };
}

/**
 * The locale a page formats its amounts in: the language its `<html lang>` declares, else the
 * `locale.x` PayPal's hosted pages carry. Undefined when the page names none or names one
 * `Intl` does not know: a caller then cannot read its amounts and must hold.
 */
export function pageLocale(htmlLang: string, url: string): string | undefined {
  const fromUrl = URL.parse(url)?.searchParams.get("locale.x")?.replace("_", "-");
  for (const tag of [htmlLang.trim(), fromUrl ?? ""]) {
    if (!tag) continue;
    try {
      const [canonical] = Intl.getCanonicalLocales(tag);
      if (canonical && Intl.NumberFormat.supportedLocalesOf(canonical).length > 0) return canonical;
    } catch {
      // An invalid tag is no locale.
    }
  }
  return undefined;
}
