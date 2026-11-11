import {
  type Countersign,
  countersignDigest,
  type KeelsonChainId,
  keelsonDomain,
} from "@keelson/core/eip712";
import {
  ALG_ES256K,
  addressOf,
  decodeSign1,
  decodeStrict,
  encode,
  protectedHeader,
  ScittFormatError,
  type Sign1,
  sigStructure,
  verifyEs256k,
} from "@keelson/scitt";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { getAddress, type Hex } from "viem";
import { LEAF_PREFIX, type LeafMode, MAX_LEAF_BYTES } from "./leaf.ts";

/** The content type of a purchase statement's payload. */
export const CLAIMS_CONTENT_TYPE = "application/vnd.keelson.alibi-claims+cbor";
/** The issuer every Alibi statement names in its CWT claims. */
export const STATEMENT_ISSUER = "https://keelson.finance";

/** One leg's EIP-712 countersignature as the statement carries it. */
export interface LegSignature {
  kind: "tdx" | "nitro";
  /** 20-byte signer address. */
  signer: Hex;
  /** 65-byte `r‖s‖v`. */
  signature: Hex;
  /** 32-byte measurement. */
  measurement: Hex;
}

/** What a purchase statement asserts: the countersigned facts and both legs' signatures over them. */
export interface StatementClaims {
  countersign: Countersign;
  chainId: number;
  verifyingContract: Hex;
  mode: LeafMode;
  /** `[tdx]` when degraded, `[tdx, nitro]` for 2of2. */
  legs: [LegSignature] | [LegSignature, LegSignature];
  /** The payment reference commitment (PayPal rail). */
  payRef?: Hex;
}

export type LeafFormatCode =
  | "leaf.size"
  | "leaf.version"
  | "leaf.noncanonical"
  | "leaf.format"
  | "leaf.unprotected"
  | "leaf.unknown"
  | "leaf.field"
  | "leaf.mode"
  | "leaf.signer"
  | "leaf.signature"
  | "leaf.digest";

export class LeafFormatError extends Error {
  readonly code: LeafFormatCode;

  constructor(code: LeafFormatCode, message: string) {
    super(message);
    this.name = "LeafFormatError";
    this.code = code;
  }
}

const fail = (code: LeafFormatCode, message: string): never => {
  throw new LeafFormatError(code, message);
};

const KIND = { tdx: 1, nitro: 2 } as const;
const MODE = { "2of2": 1, degraded: 2 } as const;
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const bytes = (hex: string, size: number, what: string): Uint8Array => {
  if (!new RegExp(`^0x[0-9a-fA-F]{${size * 2}}$`).test(hex))
    fail("leaf.field", `${what} is not ${size} bytes`);
  return hexToBytes(hex.slice(2));
};
const hex = (b: Uint8Array): Hex => `0x${bytesToHex(b)}`;

/** The leg whose key signs the statement: the last leg to answer. */
function statementSigner(c: StatementClaims): LegSignature {
  return (c.mode === "2of2" ? c.legs[1] : c.legs[0]) as LegSignature;
}

/** The payload: the claims as an integer-keyed map in deterministic CBOR. */
export function claimsBytes(c: StatementClaims): Uint8Array {
  const n = c.countersign;
  const map = new Map<number, unknown>([
    [1, 2],
    [2, bytes(n.requestId, 32, "requestId")],
    [3, bytes(n.mandateHash, 32, "mandateHash")],
    [4, bytes(n.mandateCommitment, 32, "mandateCommitment")],
    [5, bytes(n.cartHash, 32, "cartHash")],
    [6, BigInt(n.agentId)],
    [7, bytes(n.merchantId, 32, "merchantId")],
    [8, BigInt(n.amount)],
    [9, BigInt(n.currency)],
    [10, BigInt(n.category)],
    [11, bytes(n.evidenceRoot, 32, "evidenceRoot")],
    [12, bytes(n.evalHash, 32, "evalHash")],
    [13, bytes(n.policySetHash, 32, "policySetHash")],
    [14, BigInt(n.decision)],
    [15, BigInt(n.failedFieldsMask)],
    [16, BigInt(n.issuedAt)],
    [17, BigInt(n.expiresAt)],
    [18, BigInt(c.chainId)],
    [19, bytes(c.verifyingContract, 20, "verifyingContract")],
    [20, MODE[c.mode]],
    [
      21,
      c.legs.map((l) => [
        KIND[l.kind],
        bytes(l.signer, 20, "signer"),
        bytes(l.signature, 65, "signature"),
        bytes(l.measurement, 32, "measurement"),
      ]),
    ],
  ]);
  if (c.payRef !== undefined) map.set(22, bytes(c.payRef, 32, "payRef"));
  return encode(map);
}

/** The protected header: ES256K, the claims content type, the signer as `kid`, and CWT claims. */
export function statementProtected(signer: Hex, alibiId: string, issuedAt: number): Uint8Array {
  return encode(
    new Map<number, unknown>([
      [1, ALG_ES256K],
      [3, CLAIMS_CONTENT_TYPE],
      [4, bytes(signer, 20, "signer")],
      [
        15,
        new Map<number, unknown>([
          [1, STATEMENT_ISSUER],
          [2, alibiId],
          [6, issuedAt],
        ]),
      ],
    ]),
  );
}

/** The Sig_structure the signing leg signs. */
export function statementToBeSigned(c: StatementClaims, alibiId: string): Uint8Array {
  const prot = statementProtected(
    statementSigner(c).signer,
    alibiId,
    Number(c.countersign.issuedAt),
  );
  return sigStructure(prot, claimsBytes(c));
}

/** The ULID a `bytes32` request id right-aligns. */
export function ulidOfRequestId(requestId: Hex): string {
  const b = hexToBytes(requestId.slice(2));
  if (b.length !== 32 || b.subarray(0, 16).some((x) => x !== 0))
    fail("leaf.field", "requestId is not a ULID");
  let n = BigInt(`0x${bytesToHex(b.subarray(16))}`);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = ULID_ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

/** The address an EIP-712 `r‖s‖v` signature over `digest` recovers to, or null. */
function recoverSigner(digest: Hex, signature: Uint8Array): string | null {
  const v = signature[64] as number;
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery > 1) return null;
  const recovered = new Uint8Array(65);
  recovered[0] = recovery;
  recovered.set(signature.subarray(0, 64), 1);
  try {
    const pub = secp256k1.recoverPublicKey(recovered, hexToBytes(digest.slice(2)), {
      prehash: false,
    });
    return hex(addressOf(pub)).toLowerCase();
  } catch {
    return null;
  }
}

/** Which kind of log leaf this is: 1 (JCS with the v1 prefix) or 2 (a SCITT signed statement). */
export function leafVersion(leaf: Uint8Array): 1 | 2 {
  if (leaf[0] === 0xd2) return 2;
  const prefix = new TextEncoder().encode(LEAF_PREFIX);
  if (leaf.length >= prefix.length && prefix.every((b, i) => leaf[i] === b)) return 1;
  return fail("leaf.version", "neither a v1 leaf nor a signed statement");
}

const isBytes = (v: unknown, size: number): v is Uint8Array =>
  v instanceof Uint8Array && v.length === size;
const asUint = (v: unknown, what: string): bigint => {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "bigint" && v >= 0n) return v;
  return fail("leaf.field", `${what} is not an unsigned integer`);
};

const CLAIM_KEYS = new Set(Array.from({ length: 22 }, (_, i) => i + 1));

/**
 * Parses a v2 leaf: a SCITT signed statement with an empty unprotected header, whose payload's
 * legs signed one EIP-712 digest and whose COSE signature is by the leg its mode names.
 */
export function parseStatementLeaf(leaf: Uint8Array): {
  claims: StatementClaims;
  alibiId: string;
  signer: Hex;
  sign1: Sign1;
} {
  if (leaf.length > MAX_LEAF_BYTES) fail("leaf.size", `${leaf.length} bytes`);
  let s: Sign1;
  let header: Map<number, unknown>;
  try {
    s = decodeSign1(leaf);
    header = protectedHeader(s);
  } catch (err) {
    const code =
      err instanceof ScittFormatError && err.code === "noncanonical"
        ? "leaf.noncanonical"
        : "leaf.format";
    return fail(code, (err as Error).message);
  }
  if (s.unprotected.size !== 0)
    fail("leaf.unprotected", "a logged statement has no unprotected header");
  if ([...header.keys()].join() !== "1,3,4,15")
    fail("leaf.format", "unexpected protected header labels");
  if (header.get(1) !== ALG_ES256K) fail("leaf.format", "not ES256K");
  if (header.get(3) !== CLAIMS_CONTENT_TYPE) fail("leaf.format", "not an Alibi claims payload");
  const kid = header.get(4);
  if (!isBytes(kid, 20)) return fail("leaf.format", "kid is not an address");
  const cwt = header.get(15);
  if (!(cwt instanceof Map) || cwt.get(1) !== STATEMENT_ISSUER || typeof cwt.get(2) !== "string") {
    return fail("leaf.format", "CWT claims");
  }
  if (s.payload === null) return fail("leaf.format", "the payload is detached");

  let raw: unknown;
  try {
    raw = decodeStrict(s.payload);
  } catch (err) {
    return fail("leaf.noncanonical", (err as Error).message);
  }
  if (!(raw instanceof Map)) return fail("leaf.format", "claims are not a map");
  const m = raw as Map<unknown, unknown>;
  for (const k of m.keys())
    if (typeof k !== "number" || !CLAIM_KEYS.has(k)) fail("leaf.unknown", `claim ${String(k)}`);
  if (m.get(1) !== 2) fail("leaf.field", "claims version");
  const b32 = (k: number, what: string): Hex => {
    const v = m.get(k);
    return isBytes(v, 32) ? hex(v) : fail("leaf.field", what);
  };
  const legsRaw = m.get(21);
  if (!Array.isArray(legsRaw)) return fail("leaf.field", "legs");
  const legs = legsRaw.map((l): LegSignature => {
    if (!Array.isArray(l) || l.length !== 4 || (l[0] !== 1 && l[0] !== 2))
      return fail("leaf.field", "leg");
    const [k, signer, signature, measurement] = l as [number, unknown, unknown, unknown];
    if (!isBytes(signer, 20) || !isBytes(signature, 65) || !isBytes(measurement, 32))
      return fail("leaf.field", "leg");
    return {
      kind: k === 1 ? "tdx" : "nitro",
      signer: getAddress(hex(signer)),
      signature: hex(signature),
      measurement: hex(measurement),
    };
  });
  const modeNum = m.get(20);
  const mode: LeafMode =
    modeNum === 1 ? "2of2" : modeNum === 2 ? "degraded" : fail("leaf.field", "mode");
  const kinds = legs.map((l) => l.kind).join();
  if ((mode === "2of2" && kinds !== "tdx,nitro") || (mode === "degraded" && kinds !== "tdx")) {
    fail("leaf.mode", `${mode} with legs [${kinds}]`);
  }
  const vc = m.get(19);
  if (!isBytes(vc, 20)) return fail("leaf.field", "verifyingContract");
  const chainId = Number(asUint(m.get(18), "chainId"));
  const countersign: Countersign = {
    requestId: b32(2, "requestId"),
    mandateHash: b32(3, "mandateHash"),
    mandateCommitment: b32(4, "mandateCommitment"),
    cartHash: b32(5, "cartHash"),
    agentId: asUint(m.get(6), "agentId"),
    merchantId: b32(7, "merchantId"),
    amount: asUint(m.get(8), "amount"),
    currency: asUint(m.get(9), "currency") as unknown as number,
    category: asUint(m.get(10), "category") as unknown as number,
    evidenceRoot: b32(11, "evidenceRoot"),
    evalHash: b32(12, "evalHash"),
    policySetHash: b32(13, "policySetHash"),
    decision: asUint(m.get(14), "decision") as unknown as number,
    failedFieldsMask: asUint(m.get(15), "failedFieldsMask") as unknown as number,
    issuedAt: asUint(m.get(16), "issuedAt") as unknown as number,
    expiresAt: asUint(m.get(17), "expiresAt") as unknown as number,
  };
  const claims: StatementClaims = {
    countersign,
    chainId,
    verifyingContract: getAddress(hex(vc)),
    mode,
    legs: legs as StatementClaims["legs"],
    ...(m.has(22) ? { payRef: b32(22, "payRef") } : {}),
  };

  const alibiId = cwt.get(2) as string;
  if (ulidOfRequestId(countersign.requestId) !== alibiId)
    fail("leaf.field", "sub is not the request id");
  if (asUint(cwt.get(6), "iat") !== BigInt(countersign.issuedAt))
    fail("leaf.field", "iat is not issuedAt");
  const expected = statementSigner(claims);
  if (hex(kid).toLowerCase() !== expected.signer.toLowerCase()) {
    fail("leaf.signer", `the statement is signed by ${hex(kid)}, not the ${expected.kind} leg`);
  }
  if (!verifyEs256k(s, kid)) fail("leaf.signature", "the statement signature does not verify");

  let digest: Hex;
  try {
    digest = countersignDigest(
      countersign,
      keelsonDomain(chainId as KeelsonChainId, claims.verifyingContract),
    );
  } catch (err) {
    return fail("leaf.field", (err as Error).message);
  }
  for (const l of legs) {
    if (recoverSigner(digest, hexToBytes(l.signature.slice(2))) !== l.signer.toLowerCase()) {
      fail("leaf.digest", `the ${l.kind} signature is not over this countersign`);
    }
  }
  return { claims, alibiId, signer: getAddress(hex(kid)), sign1: s };
}
