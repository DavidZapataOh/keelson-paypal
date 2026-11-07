/** What the user is known to be, usually from the PayPal order. */
export interface PiiValues {
  name?: string;
  email?: string;
  phone?: string;
  address?: string[];
}

export type PiiKind = "name" | "email" | "phone" | "address" | "card";

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
    .filter(
      (e) => e.value !== "" && !seen.has(e.value.toLowerCase()) && seen.add(e.value.toLowerCase()),
    )
    .sort((a, b) => b.value.length - a.value.length);
}

/**
 * Values shorter than this ("CA", "US") identify no one on their own and appear inside ordinary
 * words, so they are only redacted where they are a whole value.
 */
export const MIN_SUBSTRING_PII = 4;

const IMAGE_EXTENSIONS = "png|jpe?g|gif|webp|svg|avif|ico|bmp|css|js|mjs|json|html?|woff2?|ttf";
/** An email address, except Blink MHTML content ids and `name@2x.png`-style file names. */
export const EMAIL_PATTERN: RegExp = new RegExp(
  `[A-Za-z0-9._%+-]+@(?!mhtml\\.blink\\b)[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.(?!(?:${IMAGE_EXTENSIONS})\\b)[A-Za-z]{2,}`,
  "g",
);
/** An E.164 phone number. */
export const PHONE_PATTERN: RegExp = /(?<![\w+])\+[1-9]\d{6,14}(?!\d)/g;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mark = (kind: PiiKind) => `[redacted:${kind}]`;

/** Redacts known values, email addresses and E.164 phone numbers in free text. */
export function redactText(
  text: string,
  entries: readonly PiiEntry[],
): { text: string; hits: number } {
  let hits = 0;
  let out = text.normalize("NFC");
  for (const e of entries) {
    const whole = new RegExp(`^\\s*${escapeRegExp(e.value)}\\s*$`, "i");
    if (whole.test(out)) return { text: mark(e.kind), hits: hits + 1 };
    const body = escapeRegExp(e.value);
    const pattern =
      e.value.length >= MIN_SUBSTRING_PII
        ? new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu")
        : new RegExp(`(?<=["'>])${body}(?=["'<])`, "gu");
    out = out.replace(pattern, () => {
      hits++;
      return mark(e.kind);
    });
  }
  out = out.replace(EMAIL_PATTERN, () => {
    hits++;
    return mark("email");
  });
  out = out.replace(PHONE_PATTERN, () => {
    hits++;
    return mark("phone");
  });
  return { text: out, hits };
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

const BASE64_PART = /^Content-Transfer-Encoding:\s*base64/im;

/**
 * Whether the bytes of a public item still contain an email address or an E.164 phone number.
 * Images, ciphertext and base64 MHTML parts are not text and are not scanned.
 */
export function containsPii(mediaType: string, bytes: Uint8Array): boolean {
  if (mediaType === "image/png" || mediaType === "application/octet-stream") return false;
  let text = new TextDecoder().decode(bytes);
  if (mediaType === "multipart/related") {
    const boundary = /boundary="([^"]+)"/.exec(text)?.[1];
    if (boundary) {
      text = text
        .split(`--${boundary}`)
        .filter((part) => !BASE64_PART.test(part.slice(0, part.indexOf("\r\n\r\n") + 1)))
        .join("\n");
    }
  }
  return new RegExp(EMAIL_PATTERN.source).test(text) || new RegExp(PHONE_PATTERN.source).test(text);
}
