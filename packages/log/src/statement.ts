import {
  type CardAuthorization,
  type CardSettlement,
  type Countersign,
  cardAuthorizationDigest,
  cardSettlementDigest,
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
/** The content type of a card authorization decision's payload. */
export const CARD_AUTHORIZATION_CONTENT_TYPE =
  "application/vnd.keelson.card-authorization-claims+cbor";
/** The content type of a card settlement's payload. */
export const CARD_SETTLEMENT_CONTENT_TYPE = "application/vnd.keelson.card-settlement-claims+cbor";
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

/** The parts every statement shares: the domain, the mode and the legs that signed. */
interface Signed {
  chainId: number;
  verifyingContract: Hex;
  mode: LeafMode;
  legs: [LegSignature] | [LegSignature, LegSignature];
}

/** One card network authorization decision, linked to its purchase leaf. */
export interface CardAuthorizationClaims extends Signed {
  authorization: CardAuthorization;
  /** The purchase leaf's RFC 6962 hash. */
  parent: Hex;
  /** `cardRefCommit(salt, issuer, card token)`, computed by the legs. */
  cardRef: Hex;
}

/** One card settlement as the legs read it from the issuer, linked to its purchase leaf. */
export interface CardSettlementClaims extends Signed {
  settlement: CardSettlement;
  parent: Hex;
}

export type ParsedStatement = {
  alibiId: string;
  signer: Hex;
  sign1: Sign1;
} & (
  | { kind: "purchase"; claims: StatementClaims }
  | { kind: "card-authorization"; card: CardAuthorizationClaims }
  | { kind: "card-settlement"; card: CardSettlementClaims }
);

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
function statementSigner(c: Signed): LegSignature {
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
    ...signedEntries(c),
  ]);
  if (c.payRef !== undefined) map.set(22, bytes(c.payRef, 32, "payRef"));
  return encode(map);
}

function signedEntries(c: Signed): [number, unknown][] {
  return [
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
  ];
}

/** A card authorization decision's payload. */
export function cardAuthorizationClaimsBytes(c: CardAuthorizationClaims): Uint8Array {
  const a = c.authorization;
  return encode(
    new Map<number, unknown>([
      [1, 2],
      [2, bytes(a.requestId, 32, "requestId")],
      [3, bytes(a.countersignDigest, 32, "countersignDigest")],
      [4, bytes(a.authorizationHash, 32, "authorizationHash")],
      [5, bytes(a.merchantHash, 32, "merchantHash")],
      [6, BigInt(a.mcc)],
      [7, bytes(a.country, 2, "country")],
      [8, BigInt(a.amount)],
      [9, BigInt(a.currency)],
      [10, BigInt(a.decision)],
      [11, BigInt(a.failedMask)],
      [12, BigInt(a.issuedAt)],
      [13, bytes(c.cardRef, 32, "cardRef")],
      [14, bytes(c.parent, 32, "parent")],
      ...signedEntries(c),
    ]),
  );
}

/** A card settlement's payload. */
export function cardSettlementClaimsBytes(c: CardSettlementClaims): Uint8Array {
  const t = c.settlement;
  return encode(
    new Map<number, unknown>([
      [1, 2],
      [2, bytes(t.requestId, 32, "requestId")],
      [3, bytes(t.cardRef, 32, "cardRef")],
      [4, bytes(t.transactionHash, 32, "transactionHash")],
      [5, BigInt(t.settledMinor)],
      [6, BigInt(t.currency)],
      [7, BigInt(t.status)],
      [8, BigInt(t.settledAt)],
      [9, BigInt(t.observedAt)],
      [14, bytes(c.parent, 32, "parent")],
      ...signedEntries(c),
    ]),
  );
}

/** The protected header: ES256K, the claims content type, the signer as `kid`, and CWT claims. */
export function statementProtected(
  signer: Hex,
  alibiId: string,
  issuedAt: number,
  contentType: string = CLAIMS_CONTENT_TYPE,
): Uint8Array {
  return encode(
    new Map<number, unknown>([
      [1, ALG_ES256K],
      [3, contentType],
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

const KEYS: Record<ParsedStatement["kind"], Set<number>> = {
  purchase: new Set(Array.from({ length: 22 }, (_, i) => i + 1)),
  "card-authorization": new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 18, 19, 20, 21]),
  "card-settlement": new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 14, 18, 19, 20, 21]),
};
const KIND_OF: Record<string, ParsedStatement["kind"]> = {
  [CLAIMS_CONTENT_TYPE]: "purchase",
  [CARD_AUTHORIZATION_CONTENT_TYPE]: "card-authorization",
  [CARD_SETTLEMENT_CONTENT_TYPE]: "card-settlement",
};

/** Reads the shared domain, mode and legs of a claims map. */
function signedOf(m: Map<unknown, unknown>): Signed {
  const legsRaw = m.get(21);
  if (!Array.isArray(legsRaw)) return fail("leaf.field", "legs");
  const legs = legsRaw.map((l): LegSignature => {
    if (!Array.isArray(l) || l.length !== 4 || (l[0] !== 1 && l[0] !== 2))
      return fail("leaf.field", "leg");
    const [k, signer, signature, measurement] = l as [number, unknown, unknown, unknown];
    if (!isBytes(signer, 20) || !isBytes(signature, 65) || !isBytes(measurement, 32)) {
      return fail("leaf.field", "leg");
    }
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
  return {
    chainId: Number(asUint(m.get(18), "chainId")),
    verifyingContract: getAddress(hex(vc)),
    mode,
    legs: legs as Signed["legs"],
  };
}

/**
 * Parses a v2 leaf: a SCITT signed statement (a purchase, a card authorization decision or a card
 * settlement) with an empty unprotected header, whose payload's legs signed one EIP-712 digest and
 * whose COSE signature is by the leg its mode names.
 */
export function parseStatementLeaf(
  leaf: Uint8Array,
  opts: { verify?: boolean } = {},
): ParsedStatement {
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
  const kind = KIND_OF[String(header.get(3))];
  if (!kind) return fail("leaf.format", "not an Alibi statement content type");
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
  for (const k of m.keys()) {
    if (typeof k !== "number" || !KEYS[kind].has(k)) fail("leaf.unknown", `claim ${String(k)}`);
  }
  if (m.get(1) !== 2) fail("leaf.field", "claims version");
  const b = (k: number, size: number, what: string): Hex => {
    const v = m.get(k);
    return isBytes(v, size) ? hex(v) : fail("leaf.field", what);
  };
  const u = (k: number, what: string) => asUint(m.get(k), what) as unknown as number;
  const signed = signedOf(m);
  const domain = (): ReturnType<typeof keelsonDomain> => {
    try {
      return keelsonDomain(signed.chainId as KeelsonChainId, signed.verifyingContract);
    } catch (err) {
      return fail("leaf.field", (err as Error).message);
    }
  };

  let parsed: ParsedStatement;
  let digest: Hex;
  let requestId: Hex;
  let iat: number;
  if (kind === "purchase") {
    const countersign: Countersign = {
      requestId: b(2, 32, "requestId"),
      mandateHash: b(3, 32, "mandateHash"),
      mandateCommitment: b(4, 32, "mandateCommitment"),
      cartHash: b(5, 32, "cartHash"),
      agentId: asUint(m.get(6), "agentId"),
      merchantId: b(7, 32, "merchantId"),
      amount: asUint(m.get(8), "amount"),
      currency: u(9, "currency"),
      category: u(10, "category"),
      evidenceRoot: b(11, 32, "evidenceRoot"),
      evalHash: b(12, 32, "evalHash"),
      policySetHash: b(13, 32, "policySetHash"),
      decision: u(14, "decision"),
      failedFieldsMask: u(15, "failedFieldsMask"),
      issuedAt: u(16, "issuedAt"),
      expiresAt: u(17, "expiresAt"),
    };
    const claims: StatementClaims = {
      countersign,
      ...signed,
      ...(m.has(22) ? { payRef: b(22, 32, "payRef") } : {}),
    };
    requestId = countersign.requestId;
    iat = Number(countersign.issuedAt);
    digest = countersignDigest(countersign, domain());
    parsed = { kind, claims, alibiId: "", signer: "0x", sign1: s };
  } else if (kind === "card-authorization") {
    const authorization: CardAuthorization = {
      requestId: b(2, 32, "requestId"),
      countersignDigest: b(3, 32, "countersignDigest"),
      authorizationHash: b(4, 32, "authorizationHash"),
      merchantHash: b(5, 32, "merchantHash"),
      mcc: u(6, "mcc"),
      country: b(7, 2, "country"),
      amount: asUint(m.get(8), "amount"),
      currency: u(9, "currency"),
      decision: u(10, "decision"),
      failedMask: u(11, "failedMask"),
      issuedAt: u(12, "issuedAt"),
    };
    const card: CardAuthorizationClaims = {
      authorization,
      cardRef: b(13, 32, "cardRef"),
      parent: b(14, 32, "parent"),
      ...signed,
    };
    requestId = authorization.requestId;
    iat = Number(authorization.issuedAt);
    digest = cardAuthorizationDigest(authorization, domain());
    parsed = { kind, card, alibiId: "", signer: "0x", sign1: s };
  } else {
    const settlement: CardSettlement = {
      requestId: b(2, 32, "requestId"),
      cardRef: b(3, 32, "cardRef"),
      transactionHash: b(4, 32, "transactionHash"),
      settledMinor: asUint(m.get(5), "settledMinor"),
      currency: u(6, "currency"),
      status: u(7, "status"),
      settledAt: u(8, "settledAt"),
      observedAt: u(9, "observedAt"),
    };
    const card: CardSettlementClaims = { settlement, parent: b(14, 32, "parent"), ...signed };
    requestId = settlement.requestId;
    iat = Number(settlement.observedAt);
    digest = cardSettlementDigest(settlement, domain());
    parsed = { kind, card, alibiId: "", signer: "0x", sign1: s };
  }

  const alibiId = cwt.get(2) as string;
  if (ulidOfRequestId(requestId) !== alibiId) fail("leaf.field", "sub is not the request id");
  if (asUint(cwt.get(6), "iat") !== BigInt(iat)) fail("leaf.field", "iat");
  if (opts.verify === false) return { ...parsed, alibiId, signer: getAddress(hex(kid)) };
  const expected = statementSigner(signed);
  if (hex(kid).toLowerCase() !== expected.signer.toLowerCase()) {
    fail("leaf.signer", `the statement is signed by ${hex(kid)}, not the ${expected.kind} leg`);
  }
  if (!verifyEs256k(s, kid)) fail("leaf.signature", "the statement signature does not verify");
  for (const l of signed.legs) {
    if (recoverSigner(digest, hexToBytes(l.signature.slice(2))) !== l.signer.toLowerCase()) {
      fail("leaf.digest", `the ${l.kind} signature is not over these facts`);
    }
  }
  return { ...parsed, alibiId, signer: getAddress(hex(kid)) };
}
