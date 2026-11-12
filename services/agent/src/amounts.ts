import { convertsTo, decimalParts, exceedsConversion } from "@keelson/core";
import { partEnd, patternEnd, wordEnd, wordPatterns } from "./requote.ts";

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
  let digits = minor.get(currency);
  if (digits === undefined) {
    digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits as number;
    minor.set(currency, digits);
  }
  return digits;
}
const minor = new Map<string, number>();

/** How `locale` writes amounts of `currency`, read from CLDR through `Intl.NumberFormat`. */
interface Shape {
  fraction: number;
  /** The marks that name `currency` in this locale: its symbol and its ISO code. */
  marks: string[];
  /** The narrow symbol (`$` for USD), which names the currency only next to its ISO code. */
  narrow: string;
  /** The signs other locales write the currency with (US$, $, $US). */
  signs: string[];
}

/**
 * The symbols other locales write the currency with that also spell out its country (US$, $US,
 * CA$, R$): each one names this currency alone, whatever locale the page is in.
 */
function spelled(currency: string, any = false): string[] {
  let all = signsOf.get(currency);
  if (!all) {
    all = [
      "en",
      "en-GB",
      "en-CA",
      "en-AU",
      "es",
      "fr",
      "pt",
      "de",
      "ja",
      "zh",
      "ko",
      "ar",
      "hi",
    ].map((l) =>
      flat(
        new Intl.NumberFormat(l, { style: "currency", currency })
          .formatToParts(1)
          .find((p) => p.type === "currency")?.value ?? "",
      ).trim(),
    );
    signsOf.set(currency, all);
  }
  return all.filter((m) => (any || /\p{L}/u.test(m)) && /\p{Sc}/u.test(m));
}
/** The symbol each of a few locales writes a currency with, by currency. */
const signsOf = new Map<string, string[]>();

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
    fraction,
    marks: [
      ...new Set([mark("symbol"), mark("code"), currency, ...spelled(currency), ...names()]),
    ].filter(Boolean),
    narrow: mark("narrowSymbol"),
    signs: spelled(currency, true),
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
/** ISO codes that are also words a page may write in capitals (`text-transform: uppercase`). */
const WORDS: ReadonlySet<string> = new Set([
  "ALL",
  "BOB",
  "CUP",
  "MAD",
  "PEN",
  "SOS",
  "TOP",
  "TRY",
  "RON",
  "BAM",
  "GEL",
  "MOP",
  "NIO",
  "AED",
]);

/** A run of mask characters: `••••`, `****`, `XXXX`, `...`. */
const MASK_RUN = "(?:(?<![\\p{L}\\d])[xX]{2,}|[•●◦∙·⋅▪■*✱#]{2,}|(?<![\\p{L}\\d.])\\.{3})";
/**
 * The words checkouts announce a card's or an account's last digits with, in the languages PayPal
 * and Shopify offer checkout in.
 */
const LAST_DIGITS = [
  "ending in",
  "ending with",
  "ends in",
  "ending",
  "last four digits",
  "últimos cuatro dígitos",
  "terminada en",
  "terminado en",
  "termina en",
  "finalizada en",
  "terminación",
  "terminado em",
  "terminada em",
  "termina em",
  "com final",
  "final do cartão",
  "se terminant par",
  "se termine par",
  "finissant par",
  "endet auf",
  "endet mit",
  "endend auf",
  "endend mit",
  "eindigend op",
  "eindigt op",
  "che termina con",
  "che termina in",
  "terminante in",
  "末尾",
  "下4桁",
  "尾号",
  "尾號",
  "끝자리",
];
/**
 * The last digits of a card or an account, after the mask or the words that write them as such
 * (`••4821`, `**** 4821`, `XXXX-4821`, `ending in 4821`, `se termine par 4821`): 2 to 5 digits
 * with no separator, and what follows them is not part of their number.
 */
const MASKED = new RegExp(
  `(?:${MASK_RUN}(?:[ -]?${MASK_RUN})*[ -]?|[•●◦∙▪■*✱]|(?<!\\p{L})(?:${LAST_DIGITS.map(escapeRegex).join("|")}):? ?(?:${MASK_RUN}[ -]?)?)(\\d{2,5})(?![.,'\u2019\u066b\u066c]\\d|\\d)`,
  "giu",
);

/**
 * Where `t` writes a card's or an account's last digits, each as its start, with the space after
 * them that would join them to the next number made a line break, so they read as no amount.
 */
function unmasked(t: string): { text: string; masked: Set<number> } {
  const masked = new Set<number>();
  let text = t;
  for (const m of t.matchAll(MASKED)) {
    const end = m.index + m[0].length;
    masked.add(end - (m[1] as string).length);
    if (t[end] === " " && /\d/.test(t[end + 1] ?? "")) {
      text = `${text.slice(0, end)}\n${text.slice(end + 1)}`;
    }
  }
  return { text, masked };
}

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
  // No amount writes a thousands group after a lone 0: `0.941` is a fraction.
  if (/^0/.test(first)) return false;
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
export function values(run: string, fraction: number): number[] {
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
  "you pay",
  "you'll pay",
  "you will pay",
  "pagas",
  "pagarás",
  "a pagar",
  "due",
  "balance due",
  "amount due",
  "total a pagar",
  "importe total",
  "valor total",
  "montant total",
  "pay now",
  "pagará",
  "vai pagar",
  "você paga",
  "charged",
  "cobro",
  "cobrará",
  "итого",
  "к оплате",
  "toplam",
  "razem",
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
  "eligible",
  "elegible",
  "elegibles",
  "elegíveis",
  "qualifying",
];

/** The total words as patterns, compiled once; "subtotal" and "sub-total" are no total. */
const TOTAL_PATTERNS = wordPatterns(TOTAL.map(escapeRegex), "\\p{L}\\-");

/** Where in `label` a total word last ends, or -1. */
const totalEnd = (label: string): number => patternEnd(label, TOTAL_PATTERNS);

/** Where an amount sits on its page: the charge, money it is not charged, or another line. */
export type Context = "total" | "aside" | "line";

/**
 * Where an amount labeled `label` sits; an amount with no words before it, right after another
 * one, sits on that one's row, unless that one is aside.
 *
 * @internal
 */
export function contextOf(label: string, previous: Context): Context {
  const text = label.normalize("NFKC").toLowerCase();
  // A balance or a rate labels its own amount only: rows run together in the page's text.
  // The upper end of a range (`$10.00-$2,000.00`) is what its lower end is.
  if (/^[-–—]$/u.test(text.trim()) && previous === "aside") return "aside";
  if (!/\p{L}/u.test(text)) return previous === "aside" ? "line" : previous;
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
  /** For an amount of another currency, the ISO code that names it, if one does. */
  currency?: string;
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
function markAfter(
  t: string,
  at: number,
  marks: readonly string[],
  lone: boolean,
): string | undefined {
  const post = t.slice(at, at + 40).replace(/^ /, "");
  return marks.find(
    (m) =>
      post.startsWith(m) &&
      !/^[\p{L}\p{Sc}\d]/u.test(post.slice(m.length)) &&
      !(lone && /^\p{Lu}{3}$/u.test(m) && /^ \p{Sc}/u.test(post.slice(m.length))),
  );
}

/** A generic mark before or after a number, unless written onto the number on its other side. */
function generic(
  t: string,
  from: number,
  to: number,
  side: "before" | "after",
  lone = false,
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
  const rest = t.slice(to + (m?.[0].length ?? 0));
  if (/^\d/.test(rest) || (lone && /^\p{Lu}{3}$/u.test(mark) && /^ \p{Sc}/u.test(rest))) {
    return undefined;
  }
  return mark;
}

/**
 * Every number in `t` with the currency marks next to it, and what it is for an amount of
 * `currency` read in `locale`.
 */
function scanPlain(text: string, locale: string, currency: string): Token[] {
  const { text: t, masked } = unmasked(text);
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
  const signs = new Set(
    [...marks, narrow, ...s.signs]
      .filter((m) => /\p{Sc}/u.test(m))
      .map((m) => m.replace(/\p{L}/gu, "")),
  );
  const tokens: Token[] = [];
  let end = 0;
  let claimed = 0;
  let previous: Context = "line";
  for (const run of t.matchAll(RUN)) {
    let from = run.index;
    let to = from + run[0].length;
    if (masked.has(from)) {
      tokens.push({
        from,
        to,
        text: run[0],
        number: run[0],
        marks: [],
        kind: "plain",
        values: [],
        label: t.slice(end, from).trim(),
        context: previous,
      });
      continue;
    }
    const before = markBefore(t, from, own) ?? generic(t, from, to, "before");
    // A code after a number with no mark before it, and before another amount ("Visa 4242 USD
    // $2.95"), is that amount's.
    const lone = before === undefined;
    const after = markAfter(t, to, own, lone) ?? generic(t, from, to, "after", lone);
    // A mark the token before already wrote after its number ("$2.95 USD 4242") is not this one's.
    const ownBefore =
      before !== undefined && t.lastIndexOf(before, from) >= claimed ? before : undefined;
    const found = [ownBefore, after].filter((m): m is string => m !== undefined);
    const code = (m: string) => /^\p{Lu}{3}$/u.test(m) && ISO.has(m);
    let sure = false;
    const maybe: string[] = [];
    let other: string | undefined;
    for (const m of found) {
      if (m === currency) sure = true;
      else if (code(m)) {
        // A code that is also a word a checkout may write in capitals (ALL, TOP, PEN) may label.
        if (WORDS.has(m)) maybe.push(m);
        else other = m;
      } else if (own.includes(m)) {
        if (shared(m)) maybe.push(m);
        else sure = true;
      } else if (/\p{Sc}/u.test(m)) {
        // Any sign this currency is written with somewhere ($ for USD: US$, USD$, A$ look alike).
        if (m.includes(currency) || signs.has(m.replace(/\p{L}/gu, ""))) maybe.push(m);
        else other ??= m;
      } else maybe.push(m);
    }
    // "$10.231 COP": a sign both currencies write, and the other one's code, is the other one.
    const writes = (c: string, m: string) => {
      const o = shape(locale, c);
      return o.narrow === m || o.marks.includes(m);
    };
    let kind: Token["kind"];
    // A number that gave its code to the next amount may still be one ("490 USD $0.00").
    const gave = lone && after === undefined && /^ ?\p{Lu}{3} \p{Sc}/u.test(t.slice(to, to + 6));
    if (found.length === 0) {
      // "490 dollars", "500 yen", "Rs. 490": a currency the reader does not name may be this one.
      const named =
        /^ ?(?:dollars?|dólar(?:es)?|pesos?|yen|euros?|rupees?|reais|real|won)\b/iu.test(
          t.slice(to, to + 12),
        ) || /\bRs\.? ?$/u.test(t.slice(Math.max(0, from - 4), from));
      kind = RUN_SEPARATOR.test(run[0]) || named || gave ? "loose" : "plain";
    } else if (sure && other === undefined) kind = "target";
    else if (
      other !== undefined &&
      !sure &&
      maybe.every((m) => code(other as string) && writes(other as string, m))
    ) {
      kind = "other";
    } else kind = "loose";
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
      ...(kind === "other" && other && code(other) ? { currency: other } : {}),
      kind,
      values: kind === "target" || kind === "loose" ? values(run[0], s.fraction) : [],
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
  /** Every amount in the currency, in minor units, in page order, but a rate's unit (`1 USD =`). */
  minor: number[];
  /** What the page labels each of `minor`: the text back to the number before it. */
  labels: string[];
  /** The amounts of `minor` the page labels its total or charge, and not a balance or rate. */
  totals: number[];
  /**
   * The amounts of `minor` the page labels as money it does not charge: a balance, the range a
   * credit offer is eligible for.
   */
  offers: number[];
  /**
   * The largest value each number that may be the currency can take: one with no mark, with a
   * mark several currencies share, or written as no locale writes an amount.
   */
  loose: number[];
  /**
   * The numbers of `loose` that may be the currency only through a sign another currency on the
   * page also writes (`$ 10.236` where COP and USD both write `$`), or with no mark at all, as
   * written, with their marks.
   */
  shared: { value: number; number: string; marks: string[] }[];
  /** The values of `loose` that are the range a credit offer is eligible for: no charge where PayPal's order states it. */
  looseOffers: number[];
  /**
   * Amounts in another currency, in that currency's whole units, and whether the page labels each
   * its total or charge (a conversion of the total, "Pagarás $10.231 COP") or money it is not
   * charged (a balance). `currency` is undefined when only a sign names it.
   */
  conversions: {
    currency?: string;
    /** The signs that name it, when no code does (`$3.40`). */
    marks?: string[];
    units: string;
    total: boolean;
    aside: boolean;
    /** Whether it is the range a credit offer is eligible for. */
    offer?: boolean;
  }[];
  /**
   * The rates the page writes from the currency (`1 USD = 3.468,14 COP`), by currency, as decimal
   * strings with the digits the page shows (`3468.14`).
   */
  rates: Record<string, string>;
  /**
   * The rates the page writes to the currency from another (`1 COP = 0,00029 USD`), by currency,
   * as decimal strings with the digits the page shows (`0.00029`).
   */
  inverse: Record<string, string>;
  /** Why the page cannot be read for sure; undefined when it can. */
  unsure?: string;
}

/** `int` minor units with `scale` of them as a decimal string: `decimalText(1023101, 2)` is `10231.01`. */
export function decimalText(int: number, scale: number): string {
  const t = String(int).padStart(scale + 1, "0");
  return scale ? `${t.slice(0, -scale)}.${t.slice(-scale)}` : t;
}

/**
 * A number's value in whole units of another currency, as a decimal string with the decimals the
 * page shows (`$10.231 COP` is `10231`, `$17,18 BRL` is `17.18`); undefined unless it reads one
 * way.
 */
function units(run: string, currency: string | undefined, locale: string): string | undefined {
  const parts = run.split(RUN_SEPARATOR);
  const last = parts.at(-1) ?? "";
  for (const f of new Set([currency ? minorDigits(currency) : 2, 2, 0])) {
    let [value, ...more] = values(run, f);
    if (value === undefined) continue;
    if (more.length > 0) {
      // 3 minor digits (`1.000 KWD`) read two ways: the locale's decimal separator decides.
      const decimal = new Intl.NumberFormat(locale)
        .formatToParts(1.5)
        .find((p) => p.type === "decimal")?.value;
      if (parts.at(-2) !== decimal) return undefined;
      value = Math.min(value, ...more);
      more = [];
    }
    // Written with `f` decimals when its last separator ends the whole units; grouped otherwise.
    const shown = f > 0 && last.length === f && RUN_SEPARATOR.test(run) ? f : 0;
    return decimalText(value / 10 ** (f - shown), shown);
  }
  return undefined;
}

/**
 * A rate as a page writes it (`3.468,14`, `0.000288`, `16,6667`), with as many decimals as it
 * likes; undefined when a single separator with 3 digits after it may group or end the units.
 */
function rateOf(run: string): string | undefined {
  const parts = run.split(RUN_SEPARATOR);
  const digits = parts.filter((_, i) => i % 2 === 0);
  const seps = parts.filter((_, i) => i % 2 === 1);
  const last = seps.at(-1);
  if (last === undefined) return run.replace(/^0+(?=\d)/, "");
  const cents = digits.at(-1) ?? "";
  const whole = digits.slice(0, -1);
  const between = seps.slice(0, -1);
  const decimal =
    DECIMALS.has(last) &&
    between.every((x) => x === between[0] && x !== last && GROUPS.has(x)) &&
    grouped(whole) &&
    (between.length > 0 || cents.length !== 3 || whole.join("") === "0");
  if (decimal) return `${whole.join("").replace(/^0+(?=\d)/, "")}.${cents}`;
  if (seps.every((x) => x === last && GROUPS.has(x)) && grouped(digits) && seps.length > 1) {
    return digits.join("");
  }
  return undefined;
}

/** The value a number with no reading may at most have: every digit a whole unit. */
const ceiling = (run: string, fraction: number) =>
  Number(run.replace(/\D/g, "").slice(0, 15)) * 10 ** fraction;

/**
 * Whether an amount of the currency is money the page does not charge: labeled a balance or a
 * credit offer's range right before it (at most two words after that label: "eligible purchases
 * of"), or the upper end of a range whose lower end is one (`after` a dash).
 */
function offer(token: Token, afterOffer: boolean): boolean {
  if (token.context !== "aside") return false;
  if (afterOffer && /^[-–—]$/u.test(token.label)) return true;
  const label = token.label.normalize("NFKC").toLowerCase();
  const end = wordEnd(label, ASIDE);
  return end >= 0 && (label.slice(end).match(/\p{L}+/gu) ?? []).length <= 2;
}

function read(text: string, locale: string, currency: string): Omit<PageReading, "locale"> {
  const fraction = minorDigits(currency);
  const tokens = scan(text, locale, currency);
  const t = plain(text);
  const minor: number[] = [];
  const labels: string[] = [];
  const offers: number[] = [];
  const totals: number[] = [];
  const loose: number[] = [];
  const shared: PageReading["shared"] = [];
  const conversions: PageReading["conversions"] = [];
  const rates: Record<string, string> = {};
  const inverse: Record<string, string> = {};
  const rated = new Set<Token>();
  const looseOffers: number[] = [];
  let looseOffer = false;
  const dash = (from: number, to: number) => /^ ?[-–—] ?$/u.test(t.slice(from, to));
  let unsure: string | undefined;
  for (const [i, token] of tokens.entries()) {
    // The number of a rate ("1 USD = 3.468,14 COP", "1 COP = 0,00029 USD") is no amount.
    if (rated.has(token)) continue;
    const next = tokens.slice(i + 1).find((n) => n.kind !== "plain");
    const unit = next !== undefined && /^ ?= ?$/.test(t.slice(token.to, next.from));
    if (token.kind === "target") {
      const [value, ...more] = token.values;
      if (value === undefined || more.length > 0) {
        unsure ??= value === undefined ? "an amount not read whole" : "an amount read two ways";
        continue;
      }
      // "1 USD = 3.468,14 COP": the unit of a rate, not money.
      if (value === 10 ** fraction && unit && next?.kind === "other" && next.currency) {
        const rate = rateOf(next.number);
        const known = rates[next.currency];
        if (rate === undefined) unsure ??= "a rate not read for sure";
        else if (known !== undefined && Number(known) !== Number(rate)) {
          unsure ??= "rates that disagree";
        } else rates[next.currency] = known ?? rate;
        rated.add(next);
        continue;
      }
      minor.push(value);
      labels.push(token.label);
      if (offer(token, minor.length > 1 && offers.at(-1) === minor.at(-2))) offers.push(value);
      if (token.context === "total") totals.push(value);
    } else if (token.kind === "loose") {
      if (token.values.length > 0) {
        const value = Math.max(...token.values);
        loose.push(value);
        // The range a credit offer is eligible for ("eligible purchases of $10.00-$2,000.00").
        if (
          token.context === "aside" &&
          (looseOffer && /^[-–—]$/u.test(token.label)
            ? true
            : next !== undefined && dash(token.to, next.from) && offer(token, false))
        ) {
          looseOffers.push(value);
          looseOffer = true;
        } else {
          looseOffer = false;
          if (token.marks.every((m) => /\p{Sc}/u.test(m))) {
            shared.push({ value, number: token.number, marks: token.marks });
          }
        }
      }
      // A number with a separator no locale writes so may still be an amount: count it whole.
      else if (/[.,\u066b]|\d \d\d$/u.test(token.number)) {
        loose.push(ceiling(token.number, fraction));
      }
    } else if (token.kind === "other") {
      const value = units(token.number, token.currency, locale);
      // "1 COP = 0,00029 USD": PayPal's rate written from the buyer's currency.
      if (
        value !== undefined &&
        Number(value) === 1 &&
        unit &&
        next?.kind === "target" &&
        token.currency
      ) {
        const rate = rateOf(next.number);
        const known = inverse[token.currency];
        if (rate === undefined || Number(rate) === 0) unsure ??= "a rate not read for sure";
        else if (known !== undefined && Number(known) !== Number(rate)) {
          unsure ??= "rates that disagree";
        } else inverse[token.currency] = known ?? rate;
        rated.add(next);
        continue;
      }
      if (value === undefined) {
        unsure ??= "an amount in another currency not read whole";
        continue;
      }
      // The buyer's own balance, which PayPal shows beside the total, and the range a credit
      // offer is eligible for ("eligible purchases of $10.00-$2,000.00") are no charge.
      const credit =
        token.context === "aside" &&
        (conversions.at(-1)?.offer === true && /^[-–—]$/u.test(token.label)
          ? true
          : next?.kind === "other" && dash(token.to, next.from) && offer(token, false));
      conversions.push({
        ...(token.currency ? { currency: token.currency } : { marks: token.marks }),
        units: value,
        total: token.context === "total",
        aside:
          token.context === "aside" &&
          (credit || /paypal|disponible|available/iu.test(token.label)),
        ...(credit ? { offer: true } : {}),
      });
    }
  }
  return {
    minor,
    labels,
    offers,
    totals,
    loose,
    looseOffers,
    shared,
    conversions,
    rates,
    inverse,
    ...(unsure ? { unsure } : {}),
  };
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
    return {
      locale: "",
      minor: [],
      labels: [],
      totals: [],
      offers: [],
      loose: [],
      looseOffers: [],
      shared: [],
      conversions: [],
      rates: {},
      inverse: {},
      unsure: "no locale",
    };
  }
  const readings = locales.map((l) => read(text, l, currency));
  const reading = readings[0] as Omit<PageReading, "locale">;
  const unsure = readings.find((r) => r.unsure)?.unsure;
  if (unsure) return { locale: first, ...reading, unsure };
  const same = (r: Omit<PageReading, "locale">) =>
    r.minor.join() === reading.minor.join() &&
    r.totals.join() === reading.totals.join() &&
    r.offers.join() === reading.offers.join() &&
    r.loose.join() === reading.loose.join() &&
    JSON.stringify([r.looseOffers, r.shared, r.conversions, r.rates, r.inverse]) ===
      JSON.stringify([
        reading.looseOffers,
        reading.shared,
        reading.conversions,
        reading.rates,
        reading.inverse,
      ]);
  if (!readings.every(same)) {
    return { locale: first, ...reading, unsure: "its locales read it differently" };
  }
  return { locale: first, ...reading };
}

/** PayPal's conversion of a total to the buyer's currency. */
export interface ShownConversion {
  currency: string;
  /** 1 unit of the charged currency is `rate` of `currency`: the rate PayPal's charge gives. */
  rate: string;
  /** What PayPal charges the buyer, as PayPal writes it. */
  buyer: string;
  locale: string;
}

export type Judgment = { ok: true } | { ok: false; reason: string };

/** `minor` units of `currency` as a decimal string: `2.95`, `1500`, `1.234`. */
function wholeOf(minor: number, currency: string): string {
  return decimalText(minor, minorDigits(currency));
}

/**
 * Whether a page charges `minor` of its currency and nothing more, and why not. It must be read
 * for sure and show no larger amount the buyer may be charged, whether of the currency or a number
 * that may be, and no other total. On a store's checkout its total is labeled in the currency, as
 * exactly `minor`, and no other currency shows. Where PayPal's order states the total, the page
 * need not label it (`labeled` false). On PayPal (`converts`) the page may show the total
 * converted to the buyer's currency only where PayPal's own funding data states that conversion
 * (`known`): the page's text can hold a payment, never approve one. Then an amount under a sign
 * both currencies write (`$ 10.236`) is read in the buyer's currency; no amount in it is more
 * than PayPal's conversion, a number with no mark that is exactly PayPal's charge is that charge,
 * and every converted total the page labels is it; the page's rate lines,
 * either way round (`1 USD = 3.468,14 COP`, `1 COP = 0,00029 USD`), are PayPal's own rate rounded
 * to the digits they show; and no third currency shows. The buyer's own balance does not count.
 */
export function judge(
  page: PageReading,
  minor: number,
  currency: string,
  converts = false,
  /** Whether the page must label the total; not where PayPal's order states it. */
  labeled = true,
  /**
   * PayPal's conversion of the total, from its funding data: the buyer's currency, the rate its
   * charge gives, and the rate PayPal shows.
   */
  known?: { currency: string; rate: string; buyer?: string; quote?: Quote },
): Judgment {
  const no = (reason: string): Judgment => ({ ok: false, reason });
  if (page.unsure !== undefined) return no(page.unsure);
  const whole = wholeOf(minor, currency);
  const theirs: number[] = [];
  if (known) {
    for (const a of page.shared) {
      if (a.marks.length === 0) {
        // A number with no mark is the buyer's charge only where it is that charge exactly.
        const value = units(a.number, known.currency, page.locale);
        if (
          value !== undefined &&
          known.buyer !== undefined &&
          Number(value) === Number(known.buyer)
        ) {
          theirs.push(a.value);
        }
        continue;
      }
      if (!a.marks.every((m) => writes(page.locale, known.currency, m))) continue;
      const value = units(a.number, known.currency, page.locale);
      if (value === undefined) return no("an amount in another currency not read whole");
      if (exceedsConversion(whole, known.rate, value)) {
        return no("a larger amount in the buyer's currency");
      }
      theirs.push(a.value);
    }
  }
  const loose = without(page.loose, [...theirs, ...(labeled ? [] : page.looseOffers)]);
  // Where PayPal's order states the charge, the page's balances and credit offers are no charge.
  const payable = labeled ? page.minor : without(page.minor, page.offers);
  if (Math.max(...payable, ...loose) > minor) return no("a larger amount that may be charged");
  if (page.totals.some((t) => t !== minor)) return no("another total");
  const lines = [...new Set([...Object.keys(page.rates), ...Object.keys(page.inverse)])];
  if (lines.length === 0 && page.conversions.length === 0) {
    return page.totals.includes(minor) || !labeled ? { ok: true } : no("no total labeled");
  }
  if (!converts) return no("another currency on a store's checkout");
  if (!known) return no("a conversion PayPal's funding data does not state");
  // A rate's unit is set aside as no amount; it may not hide a total under one unit.
  if (minor < 10 ** minorDigits(currency)) return no("a total under one unit next to a rate");
  if (lines.some((c) => c !== known.currency)) return no("rates to more than one currency");
  if (lines.length > 0 && !(known.quote && showsQuote(page, known.quote))) {
    return no("a rate line that is not PayPal's rate");
  }
  // An amount only a sign names is the buyer's currency where that currency writes the sign.
  const charged = page.conversions.filter((c) => !c.aside);
  const inBuyers = (c: (typeof charged)[number]) =>
    c.currency === known.currency ||
    (c.currency === undefined &&
      (c.marks ?? []).length > 0 &&
      (c.marks ?? []).every((m) => writes(page.locale, known.currency, m)));
  if (!charged.every(inBuyers)) return no("an amount in a third currency");
  if (charged.some((c) => exceedsConversion(whole, known.rate, c.units))) {
    return no("a larger amount in the buyer's currency");
  }
  if (!charged.filter((c) => c.total).every((c) => convertsTo(whole, known.rate, c.units))) {
    return no("a converted total that is not PayPal's conversion");
  }
  return { ok: true };
}

/**
 * PayPal's rate for a funding option, stated per unit: 1 unit of the order's currency in the
 * buyer's (`1 USD = 3446.55 COP`), or with `inverse`, 1 unit of the buyer's in the order's
 * (`1 COP = 0.000290145 USD`).
 */
export interface Quote {
  currency: string;
  rate: string;
  inverse: boolean;
}

/** A positive fraction `n / d`. */
type Fraction = readonly [n: bigint, d: bigint];
/** The values from `lo` to `hi`. */
type Range = readonly [lo: Fraction, hi: Fraction];

const atMost = (a: Fraction, b: Fraction) => a[0] * b[1] <= b[0] * a[1];

/** Every value a decimal shown with its digits rounds from: `0.00029` is 0.000285 to 0.000295. */
function shown(decimal: string): Range {
  const { int, scale } = decimalParts(decimal);
  const d = 2n * 10n ** BigInt(scale);
  return [
    [int === 0n ? 0n : 2n * int - 1n, d],
    [2n * int + 1n, d],
  ];
}

/** `1 / x` for every `x` of a range above zero. */
const invert = ([lo, hi]: Range): Range => [
  [hi[1], hi[0]],
  [lo[1], lo[0]],
];

const overlap = (a: Range, b: Range) => atMost(a[0], b[1]) && atMost(b[0], a[1]);

/** The units of the buyer's currency per unit of the order's that PayPal's quote may stand for. */
function quoted(q: Quote): Range | undefined {
  if (decimalParts(q.rate).int === 0n) return undefined;
  return q.inverse ? invert(shown(q.rate)) : shown(q.rate);
}

/**
 * `buyer / merchant` with 10 significant digits, rounded half up: the rate two amounts give. Its
 * trailing zeros stay, so it always shows the digits a conversion is checked with.
 */
export function rateBetween(merchant: string, buyer: string): string {
  const m = decimalParts(merchant);
  const b = decimalParts(buyer);
  if (m.int === 0n) return "0";
  const den = m.int * 10n ** BigInt(b.scale);
  const at = (decimals: number) => b.int * 10n ** BigInt(m.scale + decimals);
  const digits = (at(20) / den).toString().length;
  const decimals = Math.min(20, Math.max(0, 30 - digits));
  const q = ((2n * at(decimals) + den) / (2n * den)).toString().padStart(decimals + 1, "0");
  return decimals ? `${q.slice(0, -decimals)}.${q.slice(-decimals)}` : q;
}

/** Whether a rate line the page writes for `currency`, either way, is PayPal's quote rounded. */
function showsQuote(page: PageReading, q: Quote): boolean {
  const range = quoted(q);
  if (!range) return false;
  const forward = page.rates[q.currency];
  const inverse = page.inverse[q.currency];
  return (
    (forward === undefined || overlap(shown(forward), range)) &&
    (inverse === undefined ||
      (decimalParts(inverse).int > 0n && overlap(invert(shown(inverse)), range)))
  );
}

/** Whether `locale` writes `currency` with the sign `mark`. */
function writes(locale: string, currency: string, mark: string): boolean {
  const s = shape(locale, currency);
  return s.narrow === mark || s.marks.includes(mark) || s.signs.includes(mark);
}

/** `all` less one of each of `some`. */
function without(all: readonly number[], some: readonly number[]): number[] {
  const left = [...some];
  return all.filter((x) => {
    const i = left.indexOf(x);
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
}

/**
 * Whether a page charges `minor` of its currency and nothing more: {@link judge} allows it.
 *
 * @internal
 */
export function charges(
  page: PageReading,
  minor: number,
  currency: string,
  converts = false,
): boolean {
  return judge(page, minor, currency, converts).ok;
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
