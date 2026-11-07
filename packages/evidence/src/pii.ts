/** What the user is known to be, usually from the PayPal order. */
export interface PiiValues {
  name?: string;
  email?: string;
  phone?: string;
  address?: string[];
}

export type PiiKind = "name" | "email" | "phone" | "address" | "card" | "password" | "field";

export interface PiiEntry {
  kind: PiiKind;
  value: string;
}

/** The kind of PII an `autocomplete` token names, or `null` when it names none. */
export function autocompleteKind(autocomplete: string): PiiKind | null {
  for (const token of autocomplete.toLowerCase().split(/\s+/)) {
    if (token === "name" || token === "given-name" || token === "family-name") return "name";
    if (token === "email") return "email";
    if (token === "tel") return "phone";
    if (
      token === "street-address" ||
      token === "postal-code" ||
      token === "country" ||
      /^address-(line[1-3]|level[1-4])$/.test(token)
    )
      return "address";
    if (token.startsWith("cc-")) return "card";
    if (token === "current-password" || token === "new-password") return "password";
  }
  return null;
}

/** The known values as entries, longest first so a value inside another is not split. */
export function piiEntries(
  pii: PiiValues | undefined,
  extra: readonly PiiEntry[] = [],
): PiiEntry[] {
  const out: PiiEntry[] = [...extra];
  if (pii?.name) out.push({ kind: "name", value: pii.name });
  if (pii?.email) out.push({ kind: "email", value: pii.email });
  if (pii?.phone) out.push({ kind: "phone", value: pii.phone });
  for (const line of pii?.address ?? []) out.push({ kind: "address", value: line });
  const seen = new Set<string>();
  return out
    .map((e) => ({ kind: e.kind, value: e.value.normalize("NFC").trim() }))
    .filter((e) => {
      const key = e.value.toLowerCase();
      if (e.value === "" || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.value.length - a.value.length);
}

/**
 * Values shorter than this ("CA", "US") identify no one on their own and appear inside ordinary
 * words; they are only redacted as whole form-field values.
 */
export const MIN_SUBSTRING_PII = 4;
/** A known phone number is found by its last seven digits, in any formatting. */
const PHONE_DIGITS = 7;

const FILE_EXTENSIONS = "png|jpe?g|gif|webp|svg|avif|ico|bmp|css|js|mjs|json|html?|woff2?|ttf";
/** An email address, except Blink MHTML content ids and `name@2x.png`-style file names. */
export const EMAIL_PATTERN: RegExp = new RegExp(
  `[A-Za-z0-9._%+-]+@(?!mhtml\\.blink\\b)[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.(?!(?:${FILE_EXTENSIONS})\\b)[A-Za-z]{2,}`,
  "g",
);
/** An E.164 phone number. */
export const PHONE_PATTERN: RegExp = /(?<![\w+])\+[1-9]\d{6,14}(?!\d)/g;
/** A phone number written with separators: `(415) 555-0100`, `+1 415.555.0100`. */
export const FORMATTED_PHONE_PATTERN: RegExp =
  /(?<![\w+.-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\w-])/g;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mark = (kind: PiiKind) => `[redacted:${kind}]`;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  commat: "@",
  period: ".",
  plus: "+",
  lpar: "(",
  rpar: ")",
  hyphen: "-",
  dash: "-",
};

/** Text with percent-escapes and HTML character references decoded, and where each character came from. */
interface View {
  text: string;
  start: number[];
  end: number[];
}

function decodedView(text: string, plusAsSpace: boolean): View {
  const out: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  const emit = (s: string, from: number, to: number) => {
    for (const ch of s) {
      out.push(ch);
      start.push(from);
      end.push(to);
    }
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "%" && /^%[0-9A-Fa-f]{2}/.test(text.slice(i, i + 3))) {
      const bytes: number[] = [];
      let j = i;
      while (/^%[0-9A-Fa-f]{2}/.test(text.slice(j, j + 3))) {
        bytes.push(Number.parseInt(text.slice(j + 1, j + 3), 16));
        j += 3;
      }
      emit(new TextDecoder().decode(Uint8Array.from(bytes)), i, j);
      i = j;
      continue;
    }
    if (c === "&") {
      const m = /^&(#\d{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z]{2,8});/.exec(text.slice(i, i + 12));
      if (m) {
        const ref = m[1] as string;
        let ch: string | undefined;
        if (ref.startsWith("#x") || ref.startsWith("#X"))
          ch = safeCodePoint(Number.parseInt(ref.slice(2), 16));
        else if (ref.startsWith("#")) ch = safeCodePoint(Number.parseInt(ref.slice(1), 10));
        else ch = NAMED_ENTITIES[ref.toLowerCase()];
        if (ch !== undefined) {
          emit(ch, i, i + m[0].length);
          i += m[0].length;
          continue;
        }
      }
    }
    if (c === "+" && plusAsSpace) {
      emit(" ", i, i + 1);
      i++;
      continue;
    }
    const cp = text.codePointAt(i) as number;
    const ch = String.fromCodePoint(cp);
    emit(ch, i, i + ch.length);
    i += ch.length;
  }
  return { text: out.join(""), start, end };
}

function safeCodePoint(cp: number): string | undefined {
  return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)
    ? String.fromCodePoint(cp)
    : undefined;
}

/** The views a value can hide in: as written, decoded, and decoded with `+` as a space. */
function views(text: string): View[] {
  const raw: View = { text, start: [], end: [] };
  const out = [raw];
  if (/%[0-9A-Fa-f]{2}|&#?\w+;|\+/.test(text)) {
    out.push(decodedView(text, false), decodedView(text, true));
  }
  return out;
}

function knownPattern(e: PiiEntry): RegExp | null {
  const digits = e.value.replace(/\D/g, "");
  if (e.kind === "phone" && digits.length >= PHONE_DIGITS) {
    const core = digits.slice(-PHONE_DIGITS).split("").join("[\\s().-]*");
    return new RegExp(`(?<!\\d)(?:\\+?\\d[\\d\\s().-]*?)?${core}(?!\\d)`, "g");
  }
  if (e.value.length < MIN_SUBSTRING_PII) return null;
  const body = e.value.split(/\s+/).map(escapeRegExp).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
}

interface Span {
  from: number;
  to: number;
  kind: PiiKind;
}

function findSpans(text: string, patterns: readonly [RegExp, PiiKind][]): Span[] {
  const spans: Span[] = [];
  for (const view of views(text)) {
    const raw = view.start.length === 0;
    for (const [pattern, kind] of patterns) {
      for (const m of view.text.matchAll(new RegExp(pattern.source, pattern.flags))) {
        const a = m.index;
        const b = a + m[0].length;
        if (b === a) continue;
        spans.push(
          raw
            ? { from: a, to: b, kind }
            : { from: view.start[a] as number, to: view.end[b - 1] as number, kind },
        );
      }
    }
  }
  spans.sort((x, y) => x.from - y.from || y.to - x.to);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged.at(-1);
    if (last && s.from < last.to) last.to = Math.max(last.to, s.to);
    else merged.push({ ...s });
  }
  return merged;
}

const GENERIC: [RegExp, PiiKind][] = [
  [EMAIL_PATTERN, "email"],
  [PHONE_PATTERN, "phone"],
  [FORMATTED_PHONE_PATTERN, "phone"],
];

/**
 * Redacts known values, email addresses and phone numbers in free text, also where they are
 * percent-encoded or written with HTML character references.
 */
export function redactText(
  text: string,
  entries: readonly PiiEntry[],
): { text: string; hits: number } {
  const source = text.normalize("NFC");
  const patterns: [RegExp, PiiKind][] = [];
  for (const e of entries) {
    const p = knownPattern(e);
    if (p) patterns.push([p, e.kind]);
  }
  const spans = findSpans(source, [...patterns, ...GENERIC]);
  if (spans.length === 0) return { text: source, hits: 0 };
  let out = "";
  let at = 0;
  for (const s of spans) {
    out += source.slice(at, s.from) + mark(s.kind);
    at = s.to;
  }
  return { text: out + source.slice(at), hits: spans.length };
}

/** Redacts every string in a JSON value, keys included. */
export function redactJson(
  value: unknown,
  entries: readonly PiiEntry[],
): { value: unknown; hits: number } {
  let hits = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactText(v, entries);
      hits += r.hits;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [walk(k) as string, walk(x)]));
    }
    return v;
  };
  return { value: walk(value), hits };
}

/** RFC 2045 §6.7 quoted-printable decoding of a body whose soft line breaks may remain. */
export function decodeQuotedPrintable(body: string): string {
  const unfolded = body.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let k = 0; k < unfolded.length; k++) {
    const c = unfolded.charCodeAt(k);
    const hex = c === 0x3d ? unfolded.slice(k + 1, k + 3) : "";
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      k += 2;
    } else {
      bytes.push(c & 0xff);
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

const TEXTUAL = /^(text\/|application\/(?:[\w.+-]+\+)?json\b)/i;

/** The text a public item carries; base64 MHTML parts count when they hold text or JSON. */
function scannable(mediaType: string, bytes: Uint8Array): string[] {
  const text = new TextDecoder().decode(bytes);
  if (mediaType !== "multipart/related") return [text];
  const boundary = /boundary="([^"]+)"/.exec(text)?.[1];
  if (!boundary) return [text];
  return text.split(`--${boundary}`).map((part) => {
    const at = part.indexOf("\r\n\r\n");
    if (at < 0) return part;
    const headers = part.slice(0, at);
    const body = part.slice(at + 4);
    const type = /^Content-Type:\s*([^;\r\n]+)/im.exec(headers)?.[1]?.trim() ?? "";
    if (/^Content-Transfer-Encoding:\s*base64/im.test(headers)) {
      if (!TEXTUAL.test(type)) return headers;
      const binary = atob(body.replace(/\s+/g, ""));
      return `${headers}\n${new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)))}`;
    }
    if (/^Content-Transfer-Encoding:\s*quoted-printable/im.test(headers)) {
      return `${headers}\n${decodeQuotedPrintable(body)}`;
    }
    return part;
  });
}

/**
 * Whether the bytes of a public item still contain an email address or a phone number, as written,
 * percent-encoded or as HTML character references. Images and ciphertext are not scanned.
 */
export function containsPii(mediaType: string, bytes: Uint8Array): boolean {
  if (mediaType === "image/png" || mediaType === "application/octet-stream") return false;
  return scannable(mediaType, bytes).some((text) => findSpans(text, GENERIC).length > 0);
}
