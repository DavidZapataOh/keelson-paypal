import {
  type AlibiReceipt,
  type AnyAlibi,
  decodeAny,
  decodeStatementFile,
  encodeAny,
  encodeReceipt,
} from "@keelson/alibi";
import type { AnonymousPurchase } from "@keelson/alibi/verify";

export const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 64;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const API = "https://api.keelson.finance";

/** An input the verifier refuses, with the message to show. */
export class InputError extends Error {
  override name = "InputError";
}

export interface Loaded {
  alibi: AnyAlibi;
  /** The exact bytes that were verified, for "Download this Alibi". */
  bytes: Uint8Array;
}

/** Nesting depth of a JSON text, counted without parsing it. */
function depthOf(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) max = Math.max(max, ++depth);
    else if (c === 0x7d || c === 0x5d) depth--;
  }
  return max;
}

/** Parses JSON that is small, shallow and free of prototype keys. */
export function parseJson(text: string): unknown {
  if (text.length > MAX_INPUT_BYTES) throw new InputError("The input is larger than 8 MB.");
  if (depthOf(text) > MAX_DEPTH) throw new InputError("The JSON is nested too deeply.");
  try {
    return JSON.parse(text, (key, value: unknown) => {
      if (FORBIDDEN_KEYS.has(key)) throw new InputError(`The JSON has a "${key}" key.`);
      return value;
    });
  } catch (err) {
    if (err instanceof InputError) throw err;
    throw new InputError("The input is not JSON.");
  }
}

/** An Alibi bundle or receipt from JSON text, in any spacing; the canonical bytes are kept. */
export function fromText(text: string): Loaded {
  const value = parseJson(text) as Record<string, unknown> | null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError("The JSON is not an Alibi.");
  }
  try {
    const bytes =
      "type" in value ? encodeAny(value as AnyAlibi) : encodeReceipt(value as AlibiReceipt);
    return { alibi: decodeAny(bytes), bytes };
  } catch (err) {
    const pointer = (err as { pointer?: string }).pointer;
    throw new InputError(
      `The JSON is not a valid Alibi${pointer ? ` at ${pointer}` : ""}: ${(err as Error).message}`,
    );
  }
}

/** A dropped SCITT transparent statement (`.cose`), as a v2 receipt without its log proof. */
function fromStatement(bytes: Uint8Array): Loaded {
  const alibi = decodeStatementFile(bytes);
  if (!alibi) throw new InputError("The COSE file is not an Alibi's SCITT statement.");
  return { alibi, bytes };
}

/**
 * An Alibi from a dropped file: a PDF with an embedded `.alibi`, the `.alibi` JSON itself, or an
 * Alibi's SCITT transparent statement (`.cose`, a tagged COSE_Sign1).
 */
export async function fromFile(file: Blob): Promise<Loaded> {
  if (file.size > MAX_INPUT_BYTES) throw new InputError("The file is larger than 8 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-") {
    const { extractPdf } = await import("./pdf.ts");
    let embedded: Uint8Array;
    try {
      embedded = await extractPdf(bytes);
    } catch (err) {
      throw new InputError(`The PDF carries no Alibi: ${(err as Error).message}`);
    }
    return { alibi: decodeAny(embedded), bytes: embedded };
  }
  // CBOR tag 18 (COSE_Sign1) and the four-element array that follows it.
  if (bytes[0] === 0xd2 && bytes[1] === 0x84) return fromStatement(bytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InputError("The file is neither a PDF nor UTF-8 JSON.");
  }
  return fromText(text);
}

/** The URL a QR code in an image encodes; the browser must provide `BarcodeDetector`. */
export async function qrTextOf(image: Blob): Promise<string> {
  const Detector = (
    globalThis as {
      BarcodeDetector?: new (o: {
        formats: string[];
      }) => { detect(i: ImageBitmapSource): Promise<{ rawValue: string }[]> };
    }
  ).BarcodeDetector;
  if (!Detector) {
    throw new InputError(
      "This browser cannot read QR codes from images. Open the link, or drop the PDF or .alibi file.",
    );
  }
  if (image.size > MAX_INPUT_BYTES) throw new InputError("The image is larger than 8 MB.");
  const codes = await new Detector({ formats: ["qr_code"] }).detect(await createImageBitmap(image));
  const first = codes[0];
  if (!first) throw new InputError("No QR code was found in the image.");
  return first.rawValue;
}

/**
 * The Alibi `alibiId` names: the full bundle when it is public, as a live purchase's is, or else
 * its public receipt, which anyone may read by id.
 */
export async function fromLink(alibiId: string, signal?: AbortSignal): Promise<Loaded> {
  const full = await fetch(`${API}/v1/alibis/${encodeURIComponent(alibiId)}`, {
    credentials: "omit",
    ...(signal ? { signal } : {}),
  }).catch(() => null);
  if (full?.ok) {
    const bytes = new Uint8Array(await full.arrayBuffer());
    if (bytes.length > MAX_INPUT_BYTES) throw new InputError("The Alibi is larger than 8 MB.");
    return { alibi: decodeAny(bytes), bytes };
  }
  const res = await fetch(`${API}/v1/alibis/${encodeURIComponent(alibiId)}/receipt`, {
    credentials: "omit",
    ...(signal ? { signal } : {}),
  });
  if (res.status === 404) throw new InputError("No Alibi with this id exists.");
  if (!res.ok) throw new InputError(`The receipt could not be fetched (HTTP ${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_INPUT_BYTES) throw new InputError("The receipt is larger than 8 MB.");
  return { alibi: decodeAny(bytes), bytes };
}

/** The composed anonymous proof of purchase `alibiId`, or `null` when it has none. */
export async function anonymousPurchaseOf(
  alibiId: string,
  signal?: AbortSignal,
): Promise<AnonymousPurchase | null> {
  const res = await fetch(`${API}/v1/anonymous-purchases/${encodeURIComponent(alibiId)}`, {
    credentials: "omit",
    ...(signal ? { signal } : {}),
  });
  if (res.status === 404) return null;
  if (!res.ok)
    throw new InputError(`The anonymous proof could not be fetched (HTTP ${res.status}).`);
  return (await res.json()) as AnonymousPurchase;
}

export const isImage = (f: Blob) => /^image\/(png|jpeg|gif|webp|bmp)$/.test(f.type);
