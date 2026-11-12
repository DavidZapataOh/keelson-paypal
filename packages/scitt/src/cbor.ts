import { encode as cborEncode, decode } from "cbor2";

/** Why bytes were refused: not CBOR at all, not its deterministic form, or not the expected shape. */
export type ScittFormatCode = "cbor" | "noncanonical" | "format" | "cmw";

export class ScittFormatError extends Error {
  readonly code: ScittFormatCode;

  constructor(code: ScittFormatCode, message: string) {
    super(message);
    this.name = "ScittFormatError";
    this.code = code;
  }
}

const encodeOptions = { cde: true } as const;
const decodeOptions = { cde: true, rejectDuplicateKeys: true, preferMap: true } as const;

/** RFC 8949 §4.2.1 core deterministic encoding. */
export function encode(value: unknown): Uint8Array {
  return cborEncode(value, encodeOptions);
}

/**
 * The same bytes as a plain `Uint8Array`. cbor2 decodes byte strings as views of its input, and a
 * Node `Buffer` (node-postgres returns `bytea` as one) re-encodes as a map, not a byte string.
 */
function plain(bytes: Uint8Array): Uint8Array {
  return bytes.constructor === Uint8Array
    ? bytes
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Decodes bytes only if they are exactly the deterministic encoding of their value. */
export function decodeStrict(input: Uint8Array): unknown {
  const bytes = plain(input);
  let value: unknown;
  try {
    value = decode(bytes, decodeOptions);
  } catch (err) {
    const message = (err as Error).message;
    throw new ScittFormatError(
      /duplicate|sort|order|indefinite|stream|preferred|shortest|encoding/i.test(message)
        ? "noncanonical"
        : "cbor",
      message,
    );
  }
  const again = encode(value);
  if (again.length !== bytes.length || again.some((b, i) => b !== bytes[i])) {
    throw new ScittFormatError("noncanonical", "not the deterministic encoding of its value");
  }
  return value;
}

/** Decodes any well-formed CBOR, keeping maps as `Map`. */
export function decodeLoose(bytes: Uint8Array): unknown {
  try {
    return decode(plain(bytes), { preferMap: true });
  } catch (err) {
    throw new ScittFormatError("cbor", (err as Error).message);
  }
}
