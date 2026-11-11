import { jcs, sha256 } from "@keelson/core";
import type { Countersign } from "@keelson/core/eip712";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { Hex } from "viem";

/** The domain prefix of every Alibi leaf. */
export const LEAF_PREFIX = "keelson.finance/alibi/v1\n";
/** The largest leaf the log admits. */
export const MAX_LEAF_BYTES = 1024;

/** `2of2` when both legs signed, `degraded` when only the TDX leg did. */
export type LeafMode = "2of2" | "degraded";

export interface LeafFields {
  /** ULID of the purchase. */
  alibiId: string;
  mandateHash: Hex;
  mandateCommitment: Hex;
  cartHash: Hex;
  evidenceRoot: Hex;
  evalHash: Hex;
  policySetHash: Hex;
  countersignDigest: Hex;
  paypalRefCommit: Hex;
  mode: LeafMode;
  /** `[tdx, nitro]` for `2of2`, `[tdx]` for `degraded`; 65-byte `r‖s‖v`. */
  teeSigs: [Hex, Hex] | [Hex];
  /** Same order and count as `teeSigs`: `tdx:<hex>` and `nitro:<hex>` measurement ids. */
  measurements: [string, string] | [string];
  agentId: bigint;
  /** Unix seconds. */
  issuedAt: number;
  /** Leaf hash of the user's previous Alibi. */
  prevAlibiByUser?: Hex;
}

const encoder = new TextEncoder();
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function bytes(hex: string, size: number, what: string): Uint8Array {
  if (!new RegExp(`^0x[0-9a-fA-F]{${size * 2}}$`).test(hex)) {
    throw new TypeError(`${what} must be ${size} bytes of hex`);
  }
  return hexToBytes(hex.slice(2));
}

function base64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

const b64 = (hex: string, size: number, what: string) => base64url(bytes(hex, size, what));

function measurementId(id: string): string {
  const m = /^(tdx|nitro):([0-9a-f]{64})$/.exec(id);
  if (!m) throw new TypeError(`malformed measurement id: ${id}`);
  return base64url(hexToBytes(m[2] as string));
}

/** The ULID a `bytes32` request id right-aligns. */
function ulidFromBytes32(requestId: Hex): string {
  const b = bytes(requestId, 32, "requestId");
  if (b.subarray(0, 16).some((x) => x !== 0)) throw new RangeError("requestId is not a ULID");
  let n = BigInt(`0x${bytesToHex(b.subarray(16))}`);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = ULID_ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

function rfc3339(unix: number): string {
  if (!Number.isSafeInteger(unix) || unix < 0)
    throw new RangeError("issuedAt must be unix seconds");
  return new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The leaf bytes: the prefix followed by the RFC 8785 form of the fields. */
export function leafBytes(f: LeafFields): Uint8Array {
  const n = f.mode === "2of2" ? 2 : f.mode === "degraded" ? 1 : 0;
  if (n === 0) throw new TypeError(`unknown mode: ${String(f.mode)}`);
  if (f.teeSigs.length !== n || f.measurements.length !== n) {
    throw new TypeError(`a ${f.mode} leaf carries exactly ${n} signatures and measurements`);
  }
  if (f.agentId < 0n || f.agentId >= 1n << 256n) throw new RangeError("agentId is not a uint256");
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(f.alibiId))
    throw new TypeError("alibiId is not a ULID");
  const body = {
    agent_id: f.agentId.toString(),
    alibi_id: f.alibiId,
    cart_hash: b64(f.cartHash, 32, "cartHash"),
    countersign_digest: b64(f.countersignDigest, 32, "countersignDigest"),
    eval_hash: b64(f.evalHash, 32, "evalHash"),
    evidence_root: b64(f.evidenceRoot, 32, "evidenceRoot"),
    issued_at: rfc3339(f.issuedAt),
    mandate_commitment: b64(f.mandateCommitment, 32, "mandateCommitment"),
    mandate_hash: b64(f.mandateHash, 32, "mandateHash"),
    measurements: f.measurements.map(measurementId),
    mode: f.mode,
    paypal_ref_commit: b64(f.paypalRefCommit, 32, "paypalRefCommit"),
    policy_set_hash: b64(f.policySetHash, 32, "policySetHash"),
    ...(f.prevAlibiByUser === undefined
      ? {}
      : { prev_alibi_by_user: b64(f.prevAlibiByUser, 32, "prevAlibiByUser") }),
    tee_sigs: f.teeSigs.map((s) => b64(s, 65, "teeSigs")),
  };
  const leaf = encoder.encode(LEAF_PREFIX + jcs(body));
  if (leaf.length > MAX_LEAF_BYTES) throw new RangeError(`leaf is ${leaf.length} bytes`);
  return leaf;
}

/** The RFC 6962 leaf hash, `SHA-256(0x00 ‖ leaf)`. */
export function leafHash(leaf: Uint8Array): Uint8Array {
  const input = new Uint8Array(leaf.length + 1);
  input.set(leaf, 1);
  return sha256(input);
}

/** `SHA-256(salt ‖ order_id ‖ 0x00 ‖ authorization_id)`, the leaf's only PayPal reference. */
export function paypalRefCommit(salt: Uint8Array, orderId: string, authorizationId: string): Hex {
  if (salt.length !== 32) throw new RangeError("salt must be 32 bytes");
  const order = encoder.encode(orderId);
  const auth = encoder.encode(authorizationId);
  if (order.includes(0) || auth.includes(0)) throw new TypeError("PayPal ids never contain NUL");
  const input = new Uint8Array(32 + order.length + 1 + auth.length);
  input.set(salt, 0);
  input.set(order, 32);
  input.set(auth, 33 + order.length);
  return `0x${bytesToHex(sha256(input))}`;
}

const CARD_REF = encoder.encode("keelson/card-ref/v1\0");

/**
 * `SHA-256("keelson/card-ref/v1" ‖ 0x00 ‖ salt ‖ issuer ‖ 0x00 ‖ card_token)`: the
 * `paypal_ref_commit` of a purchase paid with a single-use card, committing to the issuer and its
 * card token instead of a PayPal order. The tag keeps it apart from any PayPal commitment.
 */
export function cardRefCommit(salt: Uint8Array, issuer: string, cardToken: string): Hex {
  if (salt.length !== 32) throw new RangeError("salt must be 32 bytes");
  const name = encoder.encode(issuer);
  const token = encoder.encode(cardToken);
  if (name.includes(0) || token.includes(0)) throw new TypeError("card ids never contain NUL");
  const input = new Uint8Array(CARD_REF.length + 32 + name.length + 1 + token.length);
  input.set(CARD_REF, 0);
  input.set(salt, CARD_REF.length);
  input.set(name, CARD_REF.length + 32);
  input.set(token, CARD_REF.length + 33 + name.length);
  return `0x${bytesToHex(sha256(input))}`;
}

/** Builds the leaf fields from the coordinator's output, as it returned them. */
export function leafFromCountersign(
  c: Countersign,
  digest: Hex,
  mode: LeafMode,
  signatures: { tdx: Hex; nitro: Hex | null },
  measurements: { tdx: string; nitro: string | null },
  paypalRefCommitment: Hex,
  prevAlibiByUser?: Hex,
): LeafFields {
  const twoOfTwo = signatures.nitro !== null && measurements.nitro !== null;
  const tdxOnly = signatures.nitro === null && measurements.nitro === null;
  if (mode === "2of2" ? !twoOfTwo : !tdxOnly) {
    throw new TypeError(`the signatures and measurements do not match a ${mode} countersign`);
  }
  return {
    alibiId: ulidFromBytes32(c.requestId),
    mandateHash: c.mandateHash,
    mandateCommitment: c.mandateCommitment,
    cartHash: c.cartHash,
    evidenceRoot: c.evidenceRoot,
    evalHash: c.evalHash,
    policySetHash: c.policySetHash,
    countersignDigest: digest,
    paypalRefCommit: paypalRefCommitment,
    mode,
    teeSigs: signatures.nitro === null ? [signatures.tdx] : [signatures.tdx, signatures.nitro],
    measurements:
      measurements.nitro === null ? [measurements.tdx] : [measurements.tdx, measurements.nitro],
    agentId: BigInt(c.agentId),
    issuedAt: Number(c.issuedAt),
    ...(prevAlibiByUser === undefined ? {} : { prevAlibiByUser }),
  };
}
