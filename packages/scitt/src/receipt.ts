import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Tag } from "cbor2";
import { decodeStrict, encode, type ScittFormatError } from "./cbor.ts";
import { ALG_ED25519, decodeSign1, protectedHeader, verifyEd25519 } from "./sign1.ts";

/** COSE header labels (RFC 9942, RFC 9921). */
export const RECEIPTS = 394;
export const VDS = 395;
export const VDP = 396;
export const TST_CTT = 270;
/** The verifiable data structure of an RFC 9162 Merkle tree with SHA-256. */
export const RFC9162_SHA256 = 1;
const INCLUSION = -1;

export type ScittReceiptCode = "format" | "vds" | "index" | "kid" | "signature";

export class ScittReceiptError extends Error {
  readonly code: ScittReceiptCode;

  constructor(code: ScittReceiptCode, message: string) {
    super(message);
    this.name = "ScittReceiptError";
    this.code = code;
  }
}

/** RFC 9162 §2.1.1 leaf hash: `SHA-256(0x00 ‖ entry)`. */
export function leafHash(entry: Uint8Array): Uint8Array {
  const input = new Uint8Array(entry.length + 1);
  input.set(entry, 1);
  return sha256(input);
}

function node(left: Uint8Array, right: Uint8Array): Uint8Array {
  const input = new Uint8Array(65);
  input[0] = 1;
  input.set(left, 1);
  input.set(right, 33);
  return sha256(input);
}

/** The root an inclusion path yields (RFC 9162 §2.1.3.2); throws on a malformed proof. */
export function rootFromInclusion(
  leaf: Uint8Array,
  index: bigint,
  size: bigint,
  path: Uint8Array[],
): Uint8Array {
  if (index >= size) throw new ScittReceiptError("index", "leaf_index is not below tree_size");
  if (leaf.length !== 32 || path.some((p) => p.length !== 32)) {
    throw new ScittReceiptError("format", "hashes are 32 bytes");
  }
  let fn = index;
  let sn = size - 1n;
  let r = leaf;
  for (const p of path) {
    if (sn === 0n) throw new ScittReceiptError("signature", "the path is too long");
    if ((fn & 1n) === 1n || fn === sn) {
      r = node(p, r);
      if ((fn & 1n) === 0n) {
        while ((fn & 1n) === 0n && fn !== 0n) {
          fn >>= 1n;
          sn >>= 1n;
        }
      }
    } else {
      r = node(r, p);
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  if (sn !== 0n) throw new ScittReceiptError("signature", "the path is too short");
  return r;
}

/** The issuer of a log origin's receipts: its host as an https URI. */
function issuerOf(origin: string): string {
  return `https://${origin.split("/")[0]}`;
}

/** The protected header of an Ed25519 RFC9162_SHA256 inclusion receipt for a log origin. */
export function receiptProtected(kid: Uint8Array, origin: string): Uint8Array {
  return encode(
    new Map<number, unknown>([
      [1, ALG_ED25519],
      [4, kid],
      [
        15,
        new Map<number, string>([
          [1, issuerOf(origin)],
          [2, origin],
        ]),
      ],
      [VDS, RFC9162_SHA256],
    ]),
  );
}

/** A tagged receipt with a detached root and one inclusion proof. */
export function buildReceipt(
  protectedBytes: Uint8Array,
  signature: Uint8Array,
  treeSize: bigint,
  leafIndex: bigint,
  path: Uint8Array[],
): Uint8Array {
  if (path.length === 0) throw new ScittReceiptError("format", "an inclusion path has a hash");
  const proof = encode([treeSize, leafIndex, path]);
  return encode(
    new Tag(18, [
      protectedBytes,
      new Map([[VDP, new Map([[INCLUSION, [proof]]])]]),
      null,
      signature,
    ]),
  );
}

export interface VerifiedReceipt {
  treeSize: bigint;
  leafIndex: bigint;
  root: Uint8Array;
  /** Hex of the key id that signed it. */
  kid: string;
}

const asBig = (v: unknown): bigint | null =>
  typeof v === "bigint"
    ? v
    : typeof v === "number" && Number.isSafeInteger(v) && v >= 0
      ? BigInt(v)
      : null;

/**
 * Verifies an RFC 9942 inclusion receipt for `entry` (RFC 9942 §5.2): the inclusion proof yields
 * the root, and the root verifies as the detached payload under the key `kid` names.
 */
export function verifyReceipt(
  receipt: Uint8Array,
  entry: Uint8Array,
  keys: ReadonlyMap<string, Uint8Array>,
): VerifiedReceipt {
  let s: ReturnType<typeof decodeSign1>;
  let header: Map<number, unknown>;
  try {
    s = decodeSign1(receipt);
    header = protectedHeader(s);
  } catch (err) {
    throw new ScittReceiptError("format", (err as ScittFormatError).message);
  }
  if (s.payload !== null) throw new ScittReceiptError("format", "the root is not detached");
  if (header.get(VDS) !== RFC9162_SHA256) throw new ScittReceiptError("vds", "not RFC9162_SHA256");
  if (header.get(1) !== ALG_ED25519) throw new ScittReceiptError("format", "not Ed25519");
  const kid = header.get(4);
  if (!(kid instanceof Uint8Array)) throw new ScittReceiptError("format", "no kid");
  const proofs = (s.unprotected.get(VDP) as Map<number, unknown> | undefined)?.get(INCLUSION);
  if (!Array.isArray(proofs) || proofs.length !== 1 || !(proofs[0] instanceof Uint8Array)) {
    throw new ScittReceiptError("format", "exactly one inclusion proof");
  }
  let content: unknown;
  try {
    content = decodeStrict(proofs[0]);
  } catch (err) {
    throw new ScittReceiptError("format", (err as Error).message);
  }
  if (!Array.isArray(content) || content.length !== 3 || !Array.isArray(content[2])) {
    throw new ScittReceiptError("format", "an inclusion proof is [tree_size, leaf_index, path]");
  }
  const treeSize = asBig(content[0]);
  const leafIndex = asBig(content[1]);
  const path = content[2] as unknown[];
  if (treeSize === null || leafIndex === null || !path.every((p) => p instanceof Uint8Array)) {
    throw new ScittReceiptError("format", "malformed inclusion proof");
  }
  const key = keys.get(bytesToHex(kid));
  if (!key) throw new ScittReceiptError("kid", "the receipt key is not pinned");
  const root = rootFromInclusion(leafHash(entry), leafIndex, treeSize, path as Uint8Array[]);
  if (!verifyEd25519(s, key, root)) throw new ScittReceiptError("signature", "bad signature");
  return { treeSize, leafIndex, root, kid: bytesToHex(kid) };
}
