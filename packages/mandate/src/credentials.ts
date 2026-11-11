import { type Json, jcs } from "@keelson/core";
import {
  base64UrlToUint8Array,
  Disclosure,
  Jwt,
  pack,
  SDJwtInstance,
  uint8ArrayToBase64Url,
  validateJwtPayload,
} from "@sd-jwt/core";
import { SDJwtVcInstance } from "@sd-jwt/sd-jwt-vc";
import { compactVerify, decodeJwt, decodeProtectedHeader, importJWK } from "jose";
import { type Mandate, parseMandate } from "./schema.ts";
import { assertSdAlg, decodeMandate, sdHasher } from "./sd.ts";
import {
  assertDigestsResolved,
  assertStrictJson,
  assertStrictJwt,
  decodeStrictJson,
} from "./strict.ts";

/** `typ` of the user credential, an SD-JWT VC. */
export const USER_CREDENTIAL_TYP = "dc+sd-jwt";
/** `typ` of the open mandate, a KB-SD-JWT+KB. */
export const OPEN_MANDATE_TYP = "kb-sd-jwt+kb";
/** `typ` of the closed mandate's Key Binding JWT (RFC 9901 section 4.3). */
export const CLOSED_MANDATE_TYP = "kb+jwt";
/** `aud` of the closed mandate's Key Binding JWT. */
export const CLOSED_MANDATE_AUD = "keelson.finance/countersign";
/** `vct` of the user credential. */
export const USER_CREDENTIAL_VCT = "https://keelson.finance/credentials/user/v1";

/** A P-256 public key as a JWK (RFC 7518 section 6.2.1). */
export interface P256PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid?: string;
}

/** What {@link issueUserCredential} binds into the user credential. */
export interface UserCredentialParams {
  iss: string;
  sub: string;
  /** The user's passkey. */
  cred: { id: string; rp_id: string; jwk: P256PublicJwk };
  /** Public key of the per-user signing key that issues the user's open mandates. */
  holderJwk: P256PublicJwk;
  /** Defaults to now, in seconds since the epoch. */
  iat?: number;
}

/** The parts of the WebAuthn assertion over `M`, each base64url. */
export interface UserAuth {
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

/** What {@link issueOpenMandate} signs into the open mandate. */
export interface OpenMandateParams {
  /** The user credential, as issued: an SD-JWT with its trailing `~`. Its disclosures are dropped. */
  userCredential: string;
  payloadSd: object;
  disclosures: string[];
  userAuth: UserAuth;
  aud: string;
  nonce: string;
  /** Defaults to now, in seconds since the epoch. */
  iat?: number;
}

/** Draws the 16 bytes of a disclosure salt. */
export type SaltGenerator = () => Uint8Array;

/** A credential that {@link verifyCredential} accepted. */
export interface VerifiedCredential {
  header: Record<string, unknown>;
  /** The payload as signed, with its `_sd` digests. */
  payload: Record<string, unknown>;
  /** The payload with the presented disclosures applied. */
  claims: Record<string, unknown>;
}

/** An open mandate that {@link verifyCredential} accepted. */
export interface VerifiedOpenMandate extends VerifiedCredential {
  /** The delegate payload without its `cnf`, parsed as a mandate. */
  mandate: Mandate;
  /** The passkey assertion, checked for shape only. */
  userAuth: UserAuth;
  userCredential: VerifiedCredential;
}

/** What the open mandate must be bound to (RFC 9901 section 7.3, step 5). */
export interface OpenMandateVerifyOptions {
  expectedAud: string;
  expectedNonce: string;
  /** Current time, in seconds since the epoch. */
  now: number;
  /** Clock skew tolerated on `iat`, `nbf` and `exp`, in seconds. */
  maxSkewSec: number;
}

/** What {@link closeMandate} binds the open mandate to. */
export interface ClosedMandateParams {
  /** The request ULID, signed as `nonce`. */
  requestId: string;
  /** `sha256:<hex>` of the cart. */
  cartHash: string;
  /** Defaults to now, in seconds since the epoch. */
  iat?: number;
}

/** What a closed mandate must be bound to, on top of its open mandate. */
export interface ClosedMandateVerifyOptions {
  open: OpenMandateVerifyOptions;
  requestId: string;
  cartHash: string;
}

/** A closed mandate that {@link verifyClosedMandate} accepted. */
export interface VerifiedClosedMandate {
  open: VerifiedOpenMandate;
  /** The delegate payload's `cnf.jwk`, which signed the key binding. */
  agentJwk: P256PublicJwk;
  iat: number;
}

/** Why {@link verifyClosedMandate} rejected the agent's key binding. */
export type ClosedMandateErrorCode =
  | "closed_signature"
  | "closed_aud"
  | "closed_nonce"
  | "closed_cart_hash"
  | "closed_sd_hash"
  | "closed_iat";

/** A closed mandate whose open mandate verified but whose key binding did not. */
export class ClosedMandateError extends RangeError {
  readonly code: ClosedMandateErrorCode;

  constructor(code: ClosedMandateErrorCode) {
    super(code);
    this.name = "ClosedMandateError";
    this.code = code;
  }
}

interface TimeOptions {
  currentDate?: number;
  skewSeconds?: number;
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const CART_HASH = /^sha256:[0-9a-f]{64}$/;
// Canonical unpadded base64url of 32 bytes: 42 characters, then one with zero pad bits.
const B64URL32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const encoder = new TextEncoder();

const publicJwk = ({ kty, crv, x, y }: P256PublicJwk): P256PublicJwk => ({ kty, crv, x, y });

const randomSalt: SaltGenerator = () => crypto.getRandomValues(new Uint8Array(16));

const saltString = (salts: SaltGenerator) => (): string => {
  const salt = salts();
  if (salt.length !== 16) throw new RangeError("a salt must be 16 bytes");
  return uint8ArrayToBase64Url(salt);
};

/** Whole seconds since the epoch, as the mandate schema and the verifiers accept them. */
function issuedAt(iat: number | undefined): number {
  const t = iat ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(t) || t < 0) throw new RangeError("iat must be whole seconds");
  return t;
}

/** A P-256 point with canonical coordinates, as {@link jwkOf} and WebCrypto accept it. */
async function assertP256Point(jwk: P256PublicJwk): Promise<void> {
  try {
    await importJWK(jwkOf({ jwk: publicJwk(jwk) }), "ES256");
  } catch {
    throw new RangeError("not a P-256 public key");
  }
}

/** A disclosure as the verifiers decode it: strict JSON, `[salt, value]` or `[salt, name, value]`. */
function assertDisclosure(d: string): void {
  if (!B64URL.test(d)) throw new RangeError("disclosure is not base64url");
  Disclosure.fromArray(decodeStrictJson(d) as [string, unknown]);
}

/** ES256 (RFC 7518 section 3.4): the IEEE P1363 `r || s` signature that WebCrypto returns. */
const es256Signer = (key: CryptoKey) => async (data: string) =>
  uint8ArrayToBase64Url(
    new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(data)),
    ),
  );

const es256Verifier = (key: CryptoKey) => async (data: string, signature: string) => {
  try {
    // RFC 4648 section 3.5: non-zero pad bits would give the same signature a second encoding.
    if (uint8ArrayToBase64Url(base64UrlToUint8Array(signature)) !== signature) return false;
    // No critical header extension is supported, including the `b64` that jose understands.
    if ("crit" in decodeProtectedHeader(`${data}.${signature}`)) return false;
    await compactVerify(`${data}.${signature}`, key, { algorithms: ["ES256"] });
    return true;
  } catch {
    return false;
  }
};

const JWK_MEMBERS: ReadonlySet<string> = new Set(["kty", "crv", "x", "y", "kid"]);

/**
 * The `cnf.jwk` member: a P-256 key with canonical coordinates and no members but `kty`, `crv`,
 * `x`, `y` and a string `kid`, so `key_ops`, `ext` and private key material never reach WebCrypto.
 */
function jwkOf(cnf: unknown): P256PublicJwk {
  const jwk = (cnf as { jwk?: P256PublicJwk } | undefined)?.jwk;
  if (jwk?.kty !== "EC" || jwk.crv !== "P-256") throw new RangeError("missing cnf.jwk");
  const { kid } = jwk as { kid?: unknown };
  if (
    Object.keys(jwk).some((k) => !JWK_MEMBERS.has(k)) ||
    !["undefined", "string"].includes(typeof kid)
  ) {
    throw new RangeError("cnf.jwk has members other than kty, crv, x, y and kid");
  }
  if (!B64URL32.test(String(jwk.x)) || !B64URL32.test(String(jwk.y))) {
    throw new RangeError("cnf.jwk coordinates are not canonical base64url");
  }
  return jwk;
}

function assertUserAuth(u: unknown): asserts u is UserAuth {
  const a = u as Partial<UserAuth> | undefined;
  for (const k of ["authenticatorData", "clientDataJSON", "signature"] as const) {
    if (typeof a?.[k] !== "string" || !B64URL.test(a[k])) throw new RangeError(`user_auth.${k}`);
  }
}

/** `sd_hash` over a presented SD-JWT (RFC 9901 section 4.3.1), with its issuer's `_sd_alg`. */
function sdHash(sdJwt: string): string {
  const { payload } = Jwt.decodeJWT(sdJwt.slice(0, sdJwt.indexOf("~")));
  return uint8ArrayToBase64Url(sdHasher(sdJwt, (payload._sd_alg as string) ?? "sha-256"));
}

/**
 * Issues the user credential: an SD-JWT VC (draft-ietf-oauth-sd-jwt-vc) whose `cnf.jwk` is the
 * holder key that signs the user's open mandates, and whose selectively disclosable `sub` and
 * `cred` are the user and their passkey. Both keys must be P-256 points with canonical
 * coordinates.
 */
export async function issueUserCredential(
  params: UserCredentialParams,
  signer: CryptoKey,
  salts: SaltGenerator = randomSalt,
): Promise<string> {
  const iat = issuedAt(params.iat);
  await assertP256Point(params.holderJwk);
  await assertP256Point(params.cred.jwk);
  const sdJwt = new SDJwtVcInstance({
    signer: es256Signer(signer),
    signAlg: "ES256",
    hasher: sdHasher,
    hashAlg: "sha-256",
    saltGenerator: saltString(salts),
  });
  return sdJwt.issue(
    {
      iss: params.iss,
      iat,
      vct: USER_CREDENTIAL_VCT,
      sub: params.sub,
      cnf: { jwk: publicJwk(params.holderJwk) },
      cred: { ...params.cred, jwk: publicJwk(params.cred.jwk) },
    },
    { _sd: ["sub", "cred"] },
  );
}

/**
 * Issues the open mandate as a dSD-JWT whose KB-SD-JWT+KB, signed by the holder key, carries
 * `payloadSd` as its only delegate payload and the passkey assertion as `user_auth`. The user
 * credential is embedded without its disclosures, so `sub` and `cred` reach no verifier.
 *
 * `signer` must be the holder key in the user credential's `cnf.jwk`, and every disclosure must
 * decode as one.
 *
 * Neither the WebAuthn assertion in `userAuth` nor the mandate in `payloadSd` is checked here;
 * callers must parse the mandate, compute `M` from it and verify the assertion against `M` and
 * the user's passkey before calling this.
 * @see https://datatracker.ietf.org/doc/html/draft-ietf-oauth-delegate-sd-jwt-00
 */
export async function issueOpenMandate(
  params: OpenMandateParams,
  signer: CryptoKey,
  salts: SaltGenerator = randomSalt,
): Promise<string> {
  const { payloadSd, disclosures, userAuth, aud, nonce } = params;
  const iat = issuedAt(params.iat);
  if (!params.userCredential.endsWith("~") || params.userCredential.endsWith("~~")) {
    throw new RangeError("userCredential must be an SD-JWT without key binding");
  }
  const userCredential = `${params.userCredential.slice(0, params.userCredential.indexOf("~"))}~`;
  const holderJwk = jwkOf(Jwt.decodeJWT(userCredential.slice(0, -1)).payload.cnf);
  jwkOf((payloadSd as { cnf?: unknown }).cnf);
  assertUserAuth(userAuth);
  disclosures.forEach(assertDisclosure);
  const delegate = await pack(
    { delegate_payload: [payloadSd] },
    { delegate_payload: { _sd: [0] } },
    { hasher: sdHasher, alg: "sha-256" },
    saltString(salts),
  );
  const kbSdJwt = await new Jwt({
    header: { typ: OPEN_MANDATE_TYP, alg: "ES256" },
    payload: {
      ...delegate.packedClaims,
      _sd_alg: "sha-256",
      iat,
      aud,
      nonce,
      sd_hash: sdHash(userCredential),
      user_auth: userAuth,
    },
  }).sign(es256Signer(signer));
  const holderKey = (await importJWK(holderJwk, "ES256")) as CryptoKey;
  const dot = kbSdJwt.lastIndexOf(".");
  if (!(await es256Verifier(holderKey)(kbSdJwt.slice(0, dot), kbSdJwt.slice(dot + 1)))) {
    throw new RangeError("signer is not the user credential's cnf.jwk");
  }
  const all = [...delegate.disclosures.map((d) => d.encode()), ...disclosures];
  return `${userCredential}~${kbSdJwt}~${all.map((d) => `${d}~`).join("")}`;
}

async function verifyUserCredential(
  token: string,
  key: CryptoKey,
  time?: TimeOptions,
): Promise<VerifiedCredential> {
  const parts = token.split("~");
  if (parts.at(-1) !== "" || parts.slice(0, -1).includes("")) {
    throw new RangeError("not an SD-JWT without key binding");
  }
  assertStrictJwt(parts[0] as string);
  parts.slice(1, -1).forEach(decodeStrictJson);
  const payload = Jwt.decodeJWT(parts[0] as string).payload;
  assertSdAlg(payload);
  const { header, payload: claims } = await new SDJwtVcInstance({
    verifier: es256Verifier(key),
    hasher: sdHasher,
  }).verify(token, {
    ...time,
    allowedIssuerAlgorithms: ["ES256"],
    expectedVct: USER_CREDENTIAL_VCT,
    disableStatusVerification: true,
  });
  assertStrictJson(claims);
  // Status lists are never fetched, so a credential that carries one cannot be checked.
  if ("status" in claims) throw new RangeError("status is not supported");
  if (header?.typ !== USER_CREDENTIAL_TYP) throw new RangeError("unexpected typ");
  jwkOf(claims.cnf);
  return { header, payload, claims };
}

/**
 * Verifies a dSD-JWT as in section 6 of draft-ietf-oauth-delegate-sd-jwt-00, with one delegation,
 * and requires every delegated disclosure: the delegate payload must itself be disclosed, and every
 * digest in it, object member or array element, must be resolved.
 */
export async function verifyOpenMandate(
  token: string,
  key: CryptoKey,
  opts: OpenMandateVerifyOptions,
): Promise<VerifiedOpenMandate> {
  const { expectedAud, expectedNonce, now, maxSkewSec } = opts;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(maxSkewSec) || maxSkewSec < 0) {
    throw new RangeError("now and maxSkewSec must be whole seconds");
  }
  const time = { currentDate: now, skewSeconds: maxSkewSec };
  const parts = token.split("~");
  const split = parts.indexOf("");
  if (split < 1 || parts.at(-1) !== "" || parts.slice(split + 1, -1).includes("")) {
    throw new RangeError("not a dSD-JWT");
  }
  const sdJwt = `${parts.slice(0, split).join("~")}~`;
  const [kbJwt, ...rest] = parts.slice(split + 1);
  const userCredential = await verifyUserCredential(sdJwt, key, time);
  const holderKey = (await importJWK(jwkOf(userCredential.claims.cnf), "ES256")) as CryptoKey;
  assertStrictJwt(kbJwt as string);
  rest.slice(0, -1).forEach(decodeStrictJson);
  const signed = Jwt.decodeJWT(kbJwt as string).payload;
  assertSdAlg(signed);
  const { header, payload: claims } = await new SDJwtInstance({
    verifier: es256Verifier(holderKey),
    hasher: sdHasher,
  }).verify(`${kbJwt}~${rest.join("~")}`, { ...time, allowedIssuerAlgorithms: ["ES256"] });
  assertStrictJson(claims);
  if (header?.typ !== OPEN_MANDATE_TYP) throw new RangeError("unexpected typ");
  if (typeof signed.iat !== "number" || signed.sd_hash !== sdHash(sdJwt)) {
    throw new RangeError("invalid key binding");
  }
  if (signed.aud !== expectedAud) throw new RangeError("unexpected aud");
  if (signed.nonce !== expectedNonce) throw new RangeError("unexpected nonce");
  const signedDelegates = signed.delegate_payload;
  const delegates = claims.delegate_payload;
  if (
    !Array.isArray(signedDelegates) ||
    !Array.isArray(delegates) ||
    signedDelegates.length !== 1 ||
    delegates.length !== 1
  ) {
    throw new RangeError("expected exactly one disclosed delegate payload");
  }
  const slot = (signedDelegates[0] as { "..."?: unknown } | null)?.["..."];
  const disclosure = rest
    .slice(0, -1)
    .map((d) => Disclosure.fromEncodeSync(d, { hasher: sdHasher, alg: "sha-256" }))
    .find((d) => d._digest === slot);
  if (!disclosure) throw new RangeError("delegate payload is not disclosed");
  assertDigestsResolved(signed, rest.slice(0, -1));
  const delegate = delegates[0] as Record<string, unknown>;
  const { cnf, ...rawMandate } = delegate;
  jwkOf(cnf);
  validateJwtPayload(delegate, time);
  const mandate = parseMandate(rawMandate);
  if (jcs(cnf as Json) !== jcs({ jwk: mandate.agent.cnf.jwk })) {
    throw new RangeError("cnf differs from agent.cnf");
  }
  assertUserAuth(claims.user_auth);
  return {
    header,
    payload: disclosure.value as Record<string, unknown>,
    claims: delegate,
    mandate,
    userAuth: claims.user_auth,
    userCredential,
  };
}

/**
 * The mandate an open mandate delegates: its one delegate payload with every disclosure resolved.
 * No signature is checked; use {@link verifyCredential} where the token is not already trusted.
 */
export function readOpenMandate(openMandate: string): Mandate {
  if (!openMandate.includes("~~")) throw new RangeError("not an open mandate");
  const disclosures = finalKbSdJwt(openMandate).split("~").slice(1, -1);
  const delegate = disclosures.findIndex((d) => {
    const value = (decodeStrictJson(d) as unknown[]).at(-1) as { v?: unknown } | null;
    return value?.v === "keelson.mandate.1";
  });
  if (delegate < 0) throw new RangeError("the open mandate delegates no mandate");
  const payloadSd = (decodeStrictJson(disclosures[delegate] as string) as unknown[]).at(-1);
  return decodeMandate(
    payloadSd as object,
    disclosures.filter((_, i) => i !== delegate),
  );
}

/** The final KB-SD-JWT of a dSD-JWT and its disclosures, which the closing KB-JWT's `sd_hash` covers. */
function finalKbSdJwt(openMandate: string): string {
  return openMandate.slice(openMandate.indexOf("~~") + 2);
}

/**
 * Closes an open mandate for one request: appends a KB-JWT signed by the agent key (the delegate
 * payload's `cnf.jwk`) that binds the request ULID as `nonce` and the cart as `cart_hash`, which
 * makes the dSD-JWT a dSD-JWT+KB (draft-ietf-oauth-delegate-sd-jwt-00, section 5).
 * @see https://www.rfc-editor.org/rfc/rfc9901#section-4.3
 */
export async function closeMandate(
  openMandate: string,
  params: ClosedMandateParams,
  agentKey: CryptoKey,
): Promise<string> {
  const { requestId, cartHash, iat = Math.floor(Date.now() / 1000) } = params;
  if (!openMandate.endsWith("~") || !openMandate.includes("~~") || openMandate.endsWith("~~")) {
    throw new RangeError("not an open mandate");
  }
  if (!ULID.test(requestId)) throw new RangeError("requestId is not a ULID");
  if (!CART_HASH.test(cartHash)) throw new RangeError("cartHash is not sha256:<hex>");
  if (!Number.isSafeInteger(iat)) throw new RangeError("iat must be whole seconds");
  const kbJwt = await new Jwt({
    header: { typ: CLOSED_MANDATE_TYP, alg: "ES256" },
    payload: {
      iat,
      aud: CLOSED_MANDATE_AUD,
      nonce: requestId,
      sd_hash: sdHash(finalKbSdJwt(openMandate)),
      cart_hash: cartHash,
    },
  }).sign(es256Signer(agentKey));
  return `${openMandate}${kbJwt}`;
}

/**
 * Verifies a closed mandate: the open mandate against the issuer's public key and `opts.open`,
 * then the agent's KB-JWT against the delegate payload's `cnf.jwk` (RFC 9901 section 7.3,
 * step 5), bound to `opts.requestId` and `opts.cartHash` and issued within the skew of `now`.
 * A rejected key binding throws a {@link ClosedMandateError}.
 *
 * The WebAuthn assertion in the open mandate's `user_auth` is NOT verified here.
 */
export async function verifyClosedMandate(
  token: string,
  issuerKey: CryptoKey,
  opts: ClosedMandateVerifyOptions,
): Promise<VerifiedClosedMandate> {
  const openMandate = token.slice(0, token.lastIndexOf("~") + 1);
  if (!ULID.test(opts.requestId)) throw new RangeError("requestId is not a ULID");
  if (!CART_HASH.test(opts.cartHash)) throw new RangeError("cartHash is not sha256:<hex>");
  const open = await verifyOpenMandate(openMandate, issuerKey, opts.open);
  const { kid, ...key } = jwkOf(open.claims.cnf);
  const agentJwk = kid === undefined ? publicJwk(key) : { ...publicJwk(key), kid };
  const iat = await verifyKeyBinding(token, agentJwk, {
    requestId: opts.requestId,
    cartHash: opts.cartHash,
    now: opts.open.now,
    maxSkewSec: opts.open.maxSkewSec,
  });
  return { open, agentJwk, iat };
}

/** What the agent's key binding must bind, and the clock its `iat` is checked against. */
export interface KeyBindingVerifyOptions {
  requestId: string;
  cartHash: string;
  /** Current time, in seconds since the epoch. */
  now: number;
  maxSkewSec: number;
}

/**
 * Verifies only the KB-JWT that closes `token`: signed by `agentJwk`, over the open mandate it
 * extends (`sd_hash`), bound to `opts.requestId` and `opts.cartHash` and issued within the skew
 * of `now`. Resolves to its `iat`; a rejected key binding throws a {@link ClosedMandateError}.
 *
 * The open mandate is NOT verified here; callers verify it, or compare it with one they trust.
 */
export async function verifyKeyBinding(
  token: string,
  agentJwk: P256PublicJwk,
  opts: KeyBindingVerifyOptions,
): Promise<number> {
  const split = token.lastIndexOf("~") + 1;
  const openMandate = token.slice(0, split);
  const kbJwt = token.slice(split);
  if (!ULID.test(opts.requestId)) throw new RangeError("requestId is not a ULID");
  if (!CART_HASH.test(opts.cartHash)) throw new RangeError("cartHash is not sha256:<hex>");
  let payload: Record<string, unknown>;
  try {
    assertStrictJwt(kbJwt);
    if (decodeProtectedHeader(kbJwt).typ !== CLOSED_MANDATE_TYP) throw new RangeError("typ");
    const agentKey = (await importJWK(publicJwk(jwkOf({ jwk: agentJwk })), "ES256")) as CryptoKey;
    const dot = kbJwt.lastIndexOf(".");
    if (!(await es256Verifier(agentKey)(kbJwt.slice(0, dot), kbJwt.slice(dot + 1)))) {
      throw new RangeError("signature");
    }
    payload = decodeJwt(kbJwt);
  } catch {
    throw new ClosedMandateError("closed_signature");
  }
  if (payload.sd_hash !== sdHash(finalKbSdJwt(openMandate))) {
    throw new ClosedMandateError("closed_sd_hash");
  }
  if (payload.aud !== CLOSED_MANDATE_AUD) throw new ClosedMandateError("closed_aud");
  if (payload.nonce !== opts.requestId) throw new ClosedMandateError("closed_nonce");
  if (payload.cart_hash !== opts.cartHash) throw new ClosedMandateError("closed_cart_hash");
  const { iat } = payload;
  if (typeof iat !== "number" || Math.abs(iat - opts.now) > opts.maxSkewSec) {
    throw new ClosedMandateError("closed_iat");
  }
  return iat;
}

/**
 * Verifies a user credential (RFC 9901 section 7.1) or an open mandate against the issuer's
 * public key and returns the signed payload and the disclosed claims. For an open mandate these
 * are the delegate payload's, the holder key is taken from the user credential's `cnf`, and the
 * key binding must match `opts`.
 *
 * The WebAuthn assertion in an open mandate's `user_auth` is NOT verified here; callers must
 * verify it against `M` and the user's passkey before relying on the mandate.
 */
export function verifyCredential(
  token: string,
  expectedTyp: typeof USER_CREDENTIAL_TYP,
  publicKey: CryptoKey,
): Promise<VerifiedCredential>;
export function verifyCredential(
  token: string,
  expectedTyp: typeof OPEN_MANDATE_TYP,
  publicKey: CryptoKey,
  opts: OpenMandateVerifyOptions,
): Promise<VerifiedOpenMandate>;
export function verifyCredential(
  token: string,
  expectedTyp: typeof USER_CREDENTIAL_TYP | typeof OPEN_MANDATE_TYP,
  publicKey: CryptoKey,
  opts?: OpenMandateVerifyOptions,
): Promise<VerifiedCredential> {
  if (expectedTyp === USER_CREDENTIAL_TYP) return verifyUserCredential(token, publicKey);
  if (expectedTyp !== OPEN_MANDATE_TYP) {
    return Promise.reject(new TypeError(`unexpected typ ${expectedTyp}`));
  }
  if (!opts) return Promise.reject(new TypeError("open mandate verification needs opts"));
  return verifyOpenMandate(token, publicKey, opts);
}
