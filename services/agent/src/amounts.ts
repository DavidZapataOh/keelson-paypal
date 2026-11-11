/** An amount in minor units of an ISO 4217 currency: cents of USD, yen of JPY, fils of KWD. */
export interface Money {
  currency: string;
  minor: number;
}

/** What a page shows in one currency, read in the page's own locale. */
interface PageAmounts {
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

/**
 * The symbols other locales write the currency with that also spell out its country (US$, $US,
 * CA$, R$): each one names this currency alone, whatever locale the page is in.
 */
function spelled(currency: string): string[] {
  return ["en", "en-GB", "en-CA", "en-AU", "es", "fr", "pt", "de"]
    .map((l) =>
      flat(
        new Intl.NumberFormat(l, { style: "currency", currency })
          .formatToParts(1)
          .find((p) => p.type === "currency")?.value ?? "",
      ).trim(),
    )
    .filter((m) => /\p{L}/u.test(m) && /\p{Sc}/u.test(m));
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
  // The currency's name as the locale writes it after a number: 円, US dollars, euros.
  const names = () =>
    [1, 2].map((n) =>
      flat(
        new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: "name" })
          .formatToParts(n)
          .filter((p) => p.type === "currency")
          .map((p) => p.value)
          .join(""),
      ).trim(),
    );
  const numerals = new Intl.NumberFormat(locale, { useGrouping: false });
  const digits = [...Array(10).keys()].map((d) => numerals.format(d));
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
    marks: [
      ...new Set([mark("symbol"), mark("code"), currency, ...spelled(currency), ...names()]),
    ].filter(Boolean),
    narrow: mark("narrowSymbol"),
  };
  shapes.set(key, s);
  return s;
}

const SEPARATORS = ".,'\u2019\u066b\u066c";
/** A run of digits and the separators or single spaces between them: a number as written. */
const RUN = /\d(?:[.,'\u2019\u066b\u066c]\d|\d| (?=\d))*/gu;
/** A currency mark next to a number: a sign (`€`), letters and a sign (`US$`, `R$`) or an ISO code. */
const MARK_BEFORE = /(?<!\p{L})(\p{Lu}{0,3}\p{Sc}|\p{Lu}{3}) ?$/u;
const MARK_AFTER = /^ ?(\p{Lu}{0,3}\p{Sc}|\p{Lu}{3})(?!\p{L})/u;

/** The text as one line of plain characters: compatibility forms folded (NFKC), bidi marks gone. */
/** Every decimal digit Unicode has (Arabic-Indic, Devanagari, Thai, …), as its value 0 to 9. */
const DIGITS: ReadonlyMap<string, string> = new Map(
  Intl.supportedValuesOf("numberingSystem").flatMap((nu) => {
    try {
      const f = new Intl.NumberFormat(`en-u-nu-${nu}`, { useGrouping: false });
      if (f.resolvedOptions().numberingSystem !== nu) return [];
      return [...Array(10).keys()].map((d) => [f.format(d), String(d)] as const);
    } catch {
      return [];
    }
  }),
);

/**
 * The text as one line of plain characters: compatibility forms folded (NFKC), format characters
 * gone (zero-width spaces, joiners, soft hyphens, bidi marks), and every script's digits written
 * 0 to 9, whatever numbering the locale uses.
 */
function plain(text: string): string {
  return flat(text.normalize("NFKC").replace(/\p{Cf}/gu, "")).replace(
    /\p{Nd}/gu,
    (c) => DIGITS.get(c) ?? c,
  );
}

interface Reading {
  minor: number[];
  /** Why the text cannot be read for sure; undefined when it can. */
  unsure?: string;
}

function read(text: string, locale: string, currency: string): Reading {
  const s = shape(locale, currency);
  const t = plain(text);
  const marks = s.marks.map((m) => m.normalize("NFKC"));
  const code = new RegExp(`(?<!\\p{L})${currency}(?!\\p{L})`, "u");
  if (s.narrow && !marks.includes(s.narrow) && code.test(t)) marks.push(s.narrow.normalize("NFKC"));
  const mark = [...marks]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|");
  const g = escapeRegex(s.group);
  const d = escapeRegex(s.decimal);
  const integer = s.group
    ? `\\d{1,${s.secondary}}(?:${g}\\d{${s.secondary}})*${g}\\d{${s.primary}}|\\d+`
    : "\\d+";
  const number = `(?:${integer})${s.fraction > 0 ? `(?:${d}\\d{${s.fraction}})?` : ""}`;
  // A whole number only: no digit, separator or digit-and-space of a longer number may run on
  // before or after it, and the mark is not the tail of another one (A$, CA$) or of a word.
  const start = `(?<![\\d${escapeRegex(SEPARATORS)}${s.group === " " ? "" : g}])(?<!\\d )`;
  const amount = new RegExp(
    `(?:(?<![\\p{L}\\p{Sc}])(?:${mark}) ?${start}(${number})|${start}(${number}) ?(?:${mark})(?![\\p{L}\\p{Sc}]))(?![${escapeRegex(SEPARATORS)}${d}]?\\d)`,
    "gud",
  );
  const minor: number[] = [];
  const spans = new Set<string>();
  for (const m of t.matchAll(amount)) {
    const group = m[1] !== undefined ? 1 : 2;
    const written = m[group] as string;
    const [from, to] = (m.indices as [number, number][])[group] as [number, number];
    spans.add(`${from}:${to}`);
    const [whole = "", cents = ""] = written.split(s.decimal);
    const units = Number(s.group ? whole.replaceAll(s.group, "") : whole);
    minor.push(units * 10 ** s.fraction + Number(cents.padEnd(s.fraction, "0") || 0));
    // Cents set apart ("$15" over "99") would make the amount read smaller than it is.
    if (s.fraction > 0 && !cents && new RegExp(`^ \\d{${s.fraction}}(?!\\d)`).test(t.slice(to))) {
      return { minor, unsure: "cents apart from their amount" };
    }
  }
  // Every number written next to a currency mark must be read whole, and as this currency; and a
  // number with a separator in it, shaped like an amount wherever its mark is, must be read too.
  for (const run of t.matchAll(RUN)) {
    const from = run.index;
    const to = from + run[0].length;
    if (!spans.has(`${from}:${to}`) && /[.,'\u2019\u066b\u066c]/u.test(run[0])) {
      return { minor, unsure: "a number like an amount not read" };
    }
    const before = MARK_BEFORE.exec(t.slice(Math.max(0, from - 5), from))?.[1];
    const after = MARK_AFTER.exec(t.slice(to, to + 5))?.[1];
    const near = [before, after].filter((x): x is string => x !== undefined);
    if (near.some((x) => !marks.includes(x))) return { minor, unsure: "another currency" };
    if (
      !spans.has(`${from}:${to}`) &&
      (near.length > 0 ||
        marks.some(
          (x) =>
            t
              .slice(Math.max(0, from - x.length - 1), from)
              .trim()
              .endsWith(x) ||
            t
              .slice(to, to + x.length + 1)
              .trim()
              .startsWith(x),
        ))
    ) {
      return { minor, unsure: "an amount not read whole" };
    }
  }
  return { minor };
}

/**
 * Every amount of `currency` the text writes, read as `locale` writes it: its digits, its decimal
 * and grouping separators and group sizes, its currency marks before or after the number, and
 * any kind of space between them. The narrow symbol (`$`) counts only when the text also names
 * the currency by its ISO code, since it names several currencies. A number with no mark of the
 * currency is not an amount of it.
 */
export function readAmounts(text: string, locale: string, currency: string): PageAmounts {
  return { locale, currency, minor: read(text, locale, currency).minor };
}

/**
 * The amounts of `currency` on a page, read in each locale it names, and sure only if every one
 * reads them the same and nothing next to a currency mark is left unread or names another
 * currency. Whatever is unsure, the caller holds.
 */
export function readPage(
  text: string,
  locales: readonly string[],
  currency: string,
): { locale: string; minor: number[]; unsure?: string } {
  const [first] = locales;
  if (first === undefined) return { locale: "", minor: [], unsure: "no locale" };
  const readings = locales.map((l) => read(text, l, currency));
  const unsure = readings.find((r) => r.unsure)?.unsure;
  const minor = (readings[0] as Reading).minor;
  if (unsure) return { locale: first, minor, unsure };
  if (readings.some((r) => r.minor.join() !== minor.join())) {
    return { locale: first, minor, unsure: "its locales read it differently" };
  }
  return { locale: first, minor };
}

/**
 * The locales a page formats its amounts in: the language its `<html lang>` declares and the
 * `locale.x` PayPal's hosted pages carry, each one `Intl` knows. Empty when the page names none:
 * a caller then cannot read its amounts and must hold.
 */
export function pageLocales(htmlLang: string, url: string): string[] {
  const fromUrl = URL.parse(url)?.searchParams.get("locale.x") ?? "";
  const out: string[] = [];
  for (const tag of [htmlLang.trim(), fromUrl]) {
    if (!tag) continue;
    try {
      const [canonical] = Intl.getCanonicalLocales(tag.replaceAll("_", "-"));
      if (
        canonical &&
        !out.includes(canonical) &&
        Intl.NumberFormat.supportedLocalesOf(canonical).length > 0
      ) {
        out.push(canonical);
      }
    } catch {
      // An invalid tag is no locale.
    }
  }
  return out;
}

/** The first of {@link pageLocales}. */
export function pageLocale(htmlLang: string, url: string): string | undefined {
  return pageLocales(htmlLang, url)[0];
}
