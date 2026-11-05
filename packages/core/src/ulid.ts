import { monotonicFactory } from "ulid";
import { toHex } from "./hash.ts";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const monotonic: () => string = monotonicFactory();

/** Returns a new ULID that sorts after every ULID this process issued before. */
export function newId(): string {
  return monotonic();
}

export function isUlid(s: string): boolean {
  return ULID.test(s);
}

/** Decodes a ULID to its 16-byte big-endian form. */
export function ulidToBytes(id: string): Uint8Array {
  if (!isUlid(id)) throw new TypeError("invalid ulid");
  let n = 0n;
  for (const c of id) n = (n << 5n) | BigInt(ALPHABET.indexOf(c));
  const bytes = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return bytes;
}

/** Right-aligns the 16 ULID bytes in a `bytes32`, the on-chain id form. */
export function ulidToBytes32(id: string): `0x${string}` {
  const out = new Uint8Array(32);
  out.set(ulidToBytes(id), 16);
  return toHex(out);
}
