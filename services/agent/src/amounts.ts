import { partEnd, wordEnd } from "./requote.ts";

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
  /** What ends the whole units of an amount, which decides 1.234 of a currency with 3 minor digits. */
  decimal: string;
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
  const s: Shape = {
    // Some locales write money with another decimal than plain numbers (fr-CH: 0.01 vs 0,01).
    decimal: flat(
      (
        parts.find((p) => p.type === "decimal") ??
        new Intl.NumberFormat(locale, { minimumFractionDigits: 1 })
          .formatToParts(1.5)
          .find((p) => p.type === "decimal")
      )?.value ?? ".",
    ),
    fraction,
    marks: [
      ...new Set([mark("symbol"), mark("code"), currency, ...spelled(currency), ...names()]),
    ].filter(Boolean),
    narrow: mark("narrowSymbol"),
  };
  shapes.set(key, s);
  return s;
}

/** A run of digits and the separators or single spaces between them: a number as written. */
const RUN = /\d(?:[.,'\u2019\u066b\u066c]\d|\d| (?=\d))*/gu;
const RUN_SEPARATOR = /([.,'\u2019\u066b\u066c ])/u;
/** What groups thousands somewhere, and what ends the whole units somewhere. */
const GROUPS: ReadonlySet<string> = new Set([",", ".", " ", "'", "\u2019", "\u066c"]);
const DECIMALS: ReadonlySet<string> = new Set([".", ",", "\u066b"]);
/** A currency mark next to a number: a sign (`€`), letters and a sign (`US$`, `R$`) or an ISO code. */
const MARK_BEFORE = /(?<!\p{L})(\p{Lu}{0,3}\p{Sc}|\p{Lu}{3}) ?$/u;
const MARK_AFTER = /^ ?(\p{Lu}{0,3}\p{Sc}|\p{Lu}{3})(?!\p{L})/u;
/**
 * Three capitals checkouts write before a tax amount that are no ISO 4217 code, so next to a
 * number they label it rather than name its currency: "VAT $0.18", "IVA US$0,18", "TVA 0,18 €".
 */
const TAX_LABELS: ReadonlySet<string> = new Set([
  "VAT",
  "IVA",
  "TVA",
  "GST",
  "HST",
  "PST",
  "QST",
  "IGV",
  "BTW",
  "KDV",
  "DPH",
  "ALV",
]);
const ISO: ReadonlySet<string> = new Set(Intl.supportedValuesOf("currency"));

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
export function plain(text: string): string {
  return flat(text.normalize("NFKC").replace(/\p{Cf}/gu, "")).replace(
    /\p{Nd}/gu,
    (c) => DIGITS.get(c) ?? c,
  );
}

/** Thousands groups as some locale writes them: 3 and 3, or 3 then 2s in India. */
function grouped(groups: readonly string[]): boolean {
  if (groups.length === 1) return true;
  const [first = "", ...rest] = groups;
  const last = rest.pop() ?? "";
  if (last.length !== 3) return false;
  return (
    (first.length >= 1 && first.length <= 3 && rest.every((g) => g.length === 3)) ||
    (first.length >= 1 && first.length <= 2 && rest.every((g) => g.length === 2))
  );
}

/**
 * The values, in minor units of a currency with `fraction` of them, that a number written `run`
 * has in some locale: its last separator ends the whole units when exactly `fraction` digits
 * follow it and any other separator groups thousands; otherwise every separator groups thousands.
 * Whatever the locale, a currency with 2 or 0 minor digits gives one value at most: a group has 3
 * digits after its separator. Only 3 minor digits (KWD 1.234) can give two. None when no locale
 * writes it so (`2.9`, `15 99`, `1.000.000,5`).
 *
 * @internal
 */
export function values(run: string, fraction: number, decimal?: string): number[] {
  const parts = run.split(RUN_SEPARATOR);
  const digits = parts.filter((_, i) => i % 2 === 0);
  const seps = parts.filter((_, i) => i % 2 === 1);
  if (digits.join("").length > 15) return [];
  const scale = 10 ** fraction;
  const out = new Set<number>();
  const last = seps.at(-1);
  if (last === undefined) return [Number(run) * scale];
  const cents = digits.at(-1) ?? "";
  const whole = digits.slice(0, -1);
  const between = seps.slice(0, -1);
  if (
    fraction > 0 &&
    DECIMALS.has(last) &&
    cents.length === fraction &&
    between.every((s) => s === between[0] && s !== last && GROUPS.has(s)) &&
    grouped(whole)
  ) {
    out.add(Number(whole.join("")) * scale + Number(cents));
  }
  if (seps.every((s) => s === last && GROUPS.has(s)) && grouped(digits)) {
    out.add(Number(digits.join("")) * scale);
  }
  const all = [...out];
  // 1.234 of a currency with 3 minor digits: the page's own decimal separator decides.
  if (all.length > 1 && decimal !== undefined) {
    return [last === decimal ? Math.min(...all) : Math.max(...all)];
  }
  return all;
}

/**
 * Words a checkout labels the amount it charges with, in the languages PayPal and Shopify offer
 * checkout in: the total, and what the buyer pays.
 */
const TOTAL = [
  "total",
  "totale",
  "totaal",
  "totalt",
  "totaali",
  "gesamt",
  "gesamtbetrag",
  "gesamtsumme",
  "summe",
  "montant",
  "importe",
  "valor",
  "you pay",
  "you'll pay",
  "you will pay",
  "pay",
  "pagas",
  "pagarás",
  "pagar",
  "a pagar",
  "pague",
  "pagará",
  "vai pagar",
  "você paga",
  "charge",
  "charged",
  "cobro",
  "cargo",
  "cobrará",
  "итого",
  "к оплате",
  "toplam",
  "razem",
  "suma",
  "do zapłaty",
  "celkem",
  "yhteensä",
  "i alt",
  "összesen",
  "合計",
  "合计",
  "总计",
  "總計",
  "합계",
  "총액",
  "รวม",
  "סה״כ",
  "الإجمالي",
];
/**
 * Words that label money the buyer is not charged: a balance, a credit line, rewards, a rate of
 * exchange. The nearest of these, the total words, and the tax and shipping words, decides.
 */
const ASIDE = [
  "balance",
  "available",
  "rewards",
  "points",
  "cashback",
  "limit",
  "exchange rate",
  "conversion rate",
  "saldo",
  "disponible",
  "recompensas",
  "puntos",
  "límite",
  "tipo de cambio",
  "tasa de cambio",
  "tasa de conversión",
  "taxa de câmbio",
  "guthaben",
  "solde",
  "taux de change",
  "wechselkurs",
];

/** Where in `label` a total word last ends, or -1; "subtotal" and "sub-total" are no total. */
function totalEnd(label: string): number {
  let end = -1;
  for (const word of TOTAL) {
    const pattern = /^\p{Script=Latin}|^\p{Script=Cyrillic}/u.test(word)
      ? new RegExp(`(?<![\\p{L}\\-])${escapeRegex(word)}(?!\\p{L})`, "giu")
      : new RegExp(escapeRegex(word), "gu");
    for (const m of label.matchAll(pattern)) end = Math.max(end, m.index + m[0].length);
  }
  return end;
}

/** Where an amount sits on its page: the charge, money it is not charged, or another line. */
export type Context = "total" | "aside" | "line";

/**
 * Where an amount labeled `label` sits; an amount with no words before it, right after another
 * one, sits on that one's row.
 *
 * @internal
 */
export function contextOf(label: string, previous: Context): Context {
  const text = label.normalize("NFKC").toLowerCase();
  if (!/\p{L}/u.test(text)) return previous;
  const total = totalEnd(text);
  const aside = wordEnd(text, ASIDE);
  const part = partEnd(text);
  const nearest = Math.max(total, aside, part);
  if (nearest < 0) return "line";
  if (nearest === aside) return "aside";
  return nearest === total && total > part ? "total" : "line";
}

/** One number on a page, with the currency marks written next to it. */
export interface Token {
  from: number;
  to: number;
  /** The number and its marks, as the page writes them. */
  text: string;
  /** The number alone, as written. */
  number: string;
  /** The marks before and after the number. */
  marks: string[];
  /**
   * `target`: an amount of the currency read. `other`: of another currency. `loose`: it may be
   * the currency read (no mark, or a mark several currencies on the page share). `plain`: a
   * whole number with no mark, which is no amount.
   */
  kind: "target" | "other" | "loose" | "plain";
  /** Its values in minor units of the currency read; for `target` and `loose` only. */
  values: number[];
  /** The text between the token before it and this one. */
  label: string;
  context: Context;
}

/**
 * The mark of `marks` the text ends with before `at`, written as a mark: not inside a word, and
 * not written onto the number before it ("2.95USD 4242").
 */
function markBefore(t: string, at: number, marks: readonly string[]): string | undefined {
  const pre = t.slice(Math.max(0, at - 40), at).replace(/ $/, "");
  return marks.find((m) => pre.endsWith(m) && !/[\p{L}\p{Sc}\d]$/u.test(pre.slice(0, -m.length)));
}

/** The mark of `marks` the text starts with at `at`, unless written onto the next number ("$2.95"). */
function markAfter(t: string, at: number, marks: readonly string[]): string | undefined {
  const post = t.slice(at, at + 40).replace(/^ /, "");
  return marks.find((m) => post.startsWith(m) && !/^[\p{L}\p{Sc}\d]/u.test(post.slice(m.length)));
}

/** A generic mark before or after a number, unless written onto the number on its other side. */
function generic(
  t: string,
  from: number,
  to: number,
  side: "before" | "after",
): string | undefined {
  if (side === "before") {
    const m = MARK_BEFORE.exec(t.slice(Math.max(0, from - 5), from));
    const mark = m?.[1];
    if (mark === undefined || TAX_LABELS.has(mark)) return undefined;
    return /\d/.test(t[from - (m?.[0].length ?? 0) - 1] ?? "") ? undefined : mark;
  }
  const m = MARK_AFTER.exec(t.slice(to, to + 5));
  const mark = m?.[1];
  if (mark === undefined || TAX_LABELS.has(mark)) return undefined;
  return /\d/.test(t[to + (m?.[0].length ?? 0)] ?? "") ? undefined : mark;
}

/**
 * Every number in `t` with the currency marks next to it, and what it is for an amount of
 * `currency` read in `locale`.
 */
function scanPlain(t: string, locale: string, currency: string): Token[] {
  const s = shape(locale, currency);
  const marks = [...new Set(s.marks.map((m) => m.normalize("NFKC")))].sort(
    (a, b) => b.length - a.length,
  );
  const named = (code: string) => new RegExp(`(?<!\\p{L})${code}(?!\\p{L})`, "u").test(t);
  const narrow = s.narrow.normalize("NFKC");
  const narrowOk = narrow !== "" && !marks.includes(narrow) && named(currency);
  const others = [
    ...new Set(
      [...t.matchAll(/(?<!\p{L})\p{Lu}{3}(?!\p{L})/gu)]
        .map((m) => m[0])
        .filter((c) => c !== currency && ISO.has(c)),
    ),
  ];
  // A sign another currency named on the page also writes (COP's "$" next to USD's) names neither.
  const shared = (mark: string) =>
    others.some((c) => {
      const o = shape(locale, c);
      return o.narrow === mark || o.marks.includes(mark);
    });
  const own = narrowOk ? [...marks, narrow].sort((a, b) => b.length - a.length) : marks;
  const tokens: Token[] = [];
  let end = 0;
  let claimed = 0;
  let previous: Context = "line";
  for (const run of t.matchAll(RUN)) {
    let from = run.index;
    let to = from + run[0].length;
    const before = markBefore(t, from, own) ?? generic(t, from, to, "before");
    const after = markAfter(t, to, own) ?? generic(t, from, to, "after");
    // A mark the token before already wrote after its number ("$2.95 USD 4242") is not this one's.
    const ownBefore =
      before !== undefined && t.lastIndexOf(before, from) >= claimed ? before : undefined;
    const found = [ownBefore, after].filter((m): m is string => m !== undefined);
    const ownMark = (m: string) => m === currency || own.includes(m);
    const code = (m: string) => /^\p{Lu}{3}$/u.test(m) && ISO.has(m);
    // This currency's code or a mark no other currency on the page writes names it for sure; a
    // sign another named currency shares, or three capitals no currency has, only may.
    const sure = found.some((m) => m === currency || (ownMark(m) && !shared(m)));
    const other = found.some(
      (m) => (code(m) && m !== currency) || (/\p{Sc}/u.test(m) && !ownMark(m)),
    );
    let kind: Token["kind"];
    if (found.length === 0) kind = RUN_SEPARATOR.test(run[0]) ? "loose" : "plain";
    else if (other) kind = sure ? "loose" : "other";
    else kind = sure && found.every((m) => ownMark(m) || code(m)) ? "target" : "loose";
    if (ownBefore !== undefined) from = t.lastIndexOf(ownBefore, from);
    if (after !== undefined) to = t.indexOf(after, to) + after.length;
    if (found.length > 0) claimed = to;
    const label = t.slice(end, from).trim();
    const context = contextOf(label, previous);
    if (kind !== "plain") {
      end = to;
      previous = context;
    }
    tokens.push({
      from,
      to,
      text: t.slice(from, to),
      number: run[0],
      marks: found,
      kind,
      values: kind === "target" || kind === "loose" ? values(run[0], s.fraction, s.decimal) : [],
      label,
      context,
    });
  }
  return tokens;
}

/** Every number `text` writes, with its marks and label, read for `currency` in `locale`. */
export function scan(text: string, locale: string, currency: string): Token[] {
  return scanPlain(plain(text), locale, currency);
}

/** What a page shows in the currency read, in its own locale. */
export interface PageReading {
  locale: string;
  /** Every amount in the currency, in minor units, in page order, but money it is not charged. */
  minor: number[];
  /** What the page labels each of `minor`: the text back to the number before it. */
  labels: string[];
  /** The amounts of `minor` the page labels its total or charge. */
  totals: number[];
  /**
   * The largest values numbers that may be the currency take (no mark, or a mark several
   * currencies on the page share), but money the page labels as not charged.
   */
  loose: number[];
  /** Why the page cannot be read for sure; undefined when it can. */
  unsure?: string;
}

function read(text: string, locale: string, currency: string): Omit<PageReading, "locale"> {
  const minor: number[] = [];
  const labels: string[] = [];
  const totals: number[] = [];
  const loose: number[] = [];
  let unsure: string | undefined;
  for (const token of scan(text, locale, currency)) {
    if (token.kind === "target") {
      const [value, ...more] = token.values;
      if (value === undefined || more.length > 0) {
        unsure ??= value === undefined ? "an amount not read whole" : "an amount read two ways";
        continue;
      }
      if (token.context === "aside") continue;
      minor.push(value);
      labels.push(token.label);
      if (token.context === "total") totals.push(value);
    } else if (token.kind === "loose" && token.context !== "aside" && token.values.length > 0) {
      loose.push(Math.max(...token.values));
    }
  }
  return { minor, labels, totals, loose, ...(unsure ? { unsure } : {}) };
}

/**
 * Every amount of `currency` the text writes, read as `locale` names the currency: its symbol,
 * ISO code or name before or after the number, with any kind of space between them. A number's
 * value does not depend on the locale's separators: a group has 3 digits after its separator, so
 * `2.95` and `2,95` are both 2.95 USD, and `10.231` and `10,231` both 10,231 USD. The narrow
 * symbol (`$`) counts only when the text also names the currency by its ISO code, and no sign
 * another currency named on the page shares counts. A number with no mark of the currency is
 * not an amount of it.
 */
export function readAmounts(text: string, locale: string, currency: string): PageAmounts {
  return { locale, currency, minor: read(text, locale, currency).minor };
}

/**
 * The amounts of `currency` on a page, read in each locale it names, and sure only if every one
 * reads them the same and every number marked as the currency is read whole. Whatever is unsure,
 * the caller holds.
 */
export function readPage(text: string, locales: readonly string[], currency: string): PageReading {
  const [first] = locales;
  if (first === undefined) {
    return { locale: "", minor: [], labels: [], totals: [], loose: [], unsure: "no locale" };
  }
  const readings = locales.map((l) => read(text, l, currency));
  const reading = readings[0] as Omit<PageReading, "locale">;
  const unsure = readings.find((r) => r.unsure)?.unsure;
  if (unsure) return { locale: first, ...reading, unsure };
  const same = (r: Omit<PageReading, "locale">) =>
    r.minor.join() === reading.minor.join() &&
    r.totals.join() === reading.totals.join() &&
    r.loose.join() === reading.loose.join();
  if (!readings.every(same)) {
    return { locale: first, ...reading, unsure: "its locales read it differently" };
  }
  return { locale: first, ...reading };
}

/**
 * Whether a page charges `minor` and nothing more: read for sure, labeling exactly that amount as
 * its total or charge, and showing no larger amount the buyer may be charged, whether of the
 * currency or a number that may be. Amounts of other currencies (a conversion of the total) and
 * money the page labels as not charged (a balance, a rate) do not count.
 */
export function charges(page: PageReading, minor: number): boolean {
  return (
    page.unsure === undefined &&
    page.totals.includes(minor) &&
    Math.max(...page.minor, ...page.loose) <= minor
  );
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
