import type { AxV1 } from "../ax.ts";
import type { DomV1 } from "../dom.ts";
import { autocompleteKind, type PiiEntry, redactText } from "../pii.ts";
import type { Har } from "./har.ts";

const mark = (kind: string) => `[redacted:${kind}]`;
const FORM_FIELDS = new Set(["input", "textarea", "select"]);

/** The kind of PII a form field holds, from its `autocomplete` attribute. */
function fieldKind(node: DomV1["nodes"][number]): ReturnType<typeof autocompleteKind> {
  if (!node.tag || !FORM_FIELDS.has(node.tag)) return null;
  const autocomplete = node.attrs?.find(([k]) => k === "autocomplete")?.[1];
  return autocomplete ? autocompleteKind(autocomplete) : null;
}

/** The values of the form fields whose `autocomplete` names PII. */
export function fieldEntries(dom: DomV1): PiiEntry[] {
  const out: PiiEntry[] = [];
  for (const node of dom.nodes) {
    const kind = fieldKind(node);
    if (!kind) continue;
    const value = node.value ?? node.attrs?.find(([k]) => k === "value")?.[1];
    if (value?.trim()) out.push({ kind, value });
  }
  return out;
}

export function redactDom(dom: DomV1, entries: readonly PiiEntry[]): { dom: DomV1; hits: number } {
  let hits = 0;
  const text = (s: string) => {
    const r = redactText(s, entries);
    hits += r.hits;
    return r.text;
  };
  const nodes = dom.nodes.map((node) => {
    const out = { ...node };
    const kind = fieldKind(node);
    if (out.text !== undefined) out.text = text(out.text);
    if (out.value !== undefined) {
      if (kind && out.value.trim() !== "") {
        out.value = mark(kind);
        hits++;
      } else {
        out.value = text(out.value);
      }
    }
    if (out.attrs) {
      out.attrs = out.attrs.map(([k, v]) => {
        if (k === "value" && kind && v.trim() !== "") {
          hits++;
          return [k, mark(kind)];
        }
        return [k, text(v)];
      });
    }
    return out;
  });
  return { dom: { ...dom, url: text(dom.url), nodes }, hits };
}

export function redactAx(ax: AxV1, entries: readonly PiiEntry[]): { ax: AxV1; hits: number } {
  let hits = 0;
  const text = (s: string) => {
    const r = redactText(s, entries);
    hits += r.hits;
    return r.text;
  };
  const nodes = ax.nodes.map((node) => {
    const out = { ...node };
    if (out.name !== undefined) out.name = text(out.name);
    if (out.description !== undefined) out.description = text(out.description);
    if (typeof out.value === "string") out.value = text(out.value);
    if (out.props) {
      out.props = out.props.map(([k, v]) => [k, typeof v === "string" ? text(v) : v]);
    }
    return out;
  });
  return { ax: { ...ax, nodes }, hits };
}

export function redactHar(har: Har, entries: readonly PiiEntry[]): { har: Har; hits: number } {
  let hits = 0;
  const text = (s: string) => {
    const r = redactText(s, entries);
    hits += r.hits;
    return r.text;
  };
  const out: Har = {
    log: {
      ...har.log,
      entries: har.log.entries.map((e) => {
        const content = { ...e.response.content };
        if (content.text !== undefined) content.text = text(content.text);
        return {
          request: { ...e.request, url: text(e.request.url) },
          response: {
            ...e.response,
            headers: e.response.headers.map((h) => ({ name: h.name, value: text(h.value) })),
            content,
          },
        };
      }),
    },
  };
  return { har: out, hits };
}

function decodeQuotedPrintable(body: string): string {
  const bytes: number[] = [];
  for (let k = 0; k < body.length; k++) {
    const c = body.charCodeAt(k);
    const hex = c === 0x3d ? body.slice(k + 1, k + 3) : "";
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      k += 2;
    } else {
      bytes.push(c & 0xff);
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** RFC 2045 §6.7 quoted-printable, keeping CRLF line breaks and without soft line breaks. */
function encodeQuotedPrintable(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (let k = 0; k < bytes.length; k++) {
    const b = bytes[k] as number;
    const next = bytes[k + 1];
    if (b === 0x0d && next === 0x0a) {
      out += "\r\n";
      k++;
    } else if ((b === 0x20 || b === 0x09) && next !== undefined && next !== 0x0d) {
      out += String.fromCharCode(b);
    } else if (b >= 0x21 && b <= 0x7e && b !== 0x3d) {
      out += String.fromCharCode(b);
    } else {
      out += `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** Redacts the text parts of a normalized MHTML document; base64 parts are left alone. */
export function redactMhtml(
  mhtml: string,
  entries: readonly PiiEntry[],
): { mhtml: string; hits: number } {
  const boundary = /boundary="([^"]+)"/.exec(mhtml)?.[1];
  if (!boundary) throw new TypeError("the MHTML document has no boundary");
  const delimiter = `--${boundary}`;
  let hits = 0;
  const parts = mhtml.split(delimiter).map((part, k) => {
    const at = part.indexOf("\r\n\r\n");
    if (at < 0) return part;
    const headers = part.slice(0, at);
    const body = part.slice(at);
    if (k === 0) {
      const r = redactText(headers, entries);
      hits += r.hits;
      return r.text + body;
    }
    if (/^Content-Transfer-Encoding:\s*base64/im.test(headers)) return part;
    const quoted = /^Content-Transfer-Encoding:\s*quoted-printable/im.test(headers);
    const h = redactText(headers, entries);
    const r = redactText(quoted ? decodeQuotedPrintable(body) : body, entries);
    hits += h.hits + r.hits;
    return h.text + (quoted ? encodeQuotedPrintable(r.text) : r.text);
  });
  return { mhtml: parts.join(delimiter), hits };
}

/** Selects the form fields whose `autocomplete` names PII. */
export const PII_FIELDS_SELECTOR: string = [
  "name",
  "given-name",
  "family-name",
  "email",
  "tel",
  "street-address",
  "address-line1",
  "address-line2",
  "address-line3",
  "address-level1",
  "address-level2",
  "address-level3",
  "address-level4",
  "postal-code",
  "country",
]
  .map((token) => `[autocomplete~="${token}" i]`)
  .concat(['[autocomplete*="cc-" i]'])
  .flatMap((attr) => ["input", "textarea", "select"].map((tag) => `${tag}${attr}`))
  .join(", ");
