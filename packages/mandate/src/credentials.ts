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
import { compactVerify, importJWK } from "jose";
import { sdHasher } from "./sd.ts";

/** `typ` of the user credential, an SD-JWT VC. */
export const USER_CREDENTIAL_TYP = "dc+sd-jwt";
/** `typ` of the open mandate, a KB-SD-JWT+KB. */
export const OPEN_MANDATE_TYP = "kb-sd-jwt+kb";
/** `vct` of the user credential. */
export const USER_CREDENTIAL_VCT = "https://keelson.finance/credentials/user/v1";

export interface P256PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

export interface UserCredentialParams {
  iss: string;
  sub: string;
  /** The user's passkey. */
  cred: { id: string; rp_id: string; jwk: P256PublicJwk };
  /** Public key of the per-user signing key that issues the user's open mandates. */
  holderJwk: P256PublicJwk;
}

/** The parts of the WebAuthn assertion over `M`, each base64url. */
export interface UserAuth {
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

export interface OpenMandateParams {
  /** The user credential, as issued: an SD-JWT with its trailing `~`. */
  userCredential: string;
  payloadSd: object;
  disclosures: string[];
  userAuth: UserAuth;
  aud: string;
  nonce: string;
}

export interface VerifiedCredential {
  header: Record<string, unknown>;
  /** The payload as signed, with its `_sd` digests. */
  payload: Record<string, unknown>;
  /** The payload with the presented disclosures applied. */
  claims: Record<string, unknown>;
}

export interface VerifiedOpenMandate extends VerifiedCredential {
  userAuth: UserAuth;
  userCredential: VerifiedCredential;
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();

const publicJwk = ({ kty, crv, x, y }: P256PublicJwk): P256PublicJwk => ({ kty, crv, x, y });

const salt = (): string => uint8ArrayToBase64Url(crypto.getRandomValues(new Uint8Array(16)));

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
    await compactVerify(`${data}.${signature}`, key, { algorithms: ["ES256"] });
    return true;
  } catch {
    return false;
  }
};

function jwkOf(cnf: unknown): P256PublicJwk {
  const jwk = (cnf as { jwk?: P256PublicJwk } | undefined)?.jwk;
  if (jwk?.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string") {
    throw new RangeError("missing cnf.jwk");
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
 * holder key that signs the user's open mandates, and whose `cred` is the user's passkey.
 */
export function issueUserCredential(
  params: UserCredentialParams,
  signer: CryptoKey,
): Promise<string> {
  const sdJwt = new SDJwtVcInstance({
    signer: es256Signer(signer),
    signAlg: "ES256",
    hasher: sdHasher,
    hashAlg: "sha-256",
    saltGenerator: salt,
  });
  return sdJwt.issue({
    iss: params.iss,
    iat: Math.floor(Date.now() / 1000),
    vct: USER_CREDENTIAL_VCT,
    sub: params.sub,
    cnf: { jwk: publicJwk(params.holderJwk) },
    cred: { ...params.cred, jwk: publicJwk(params.cred.jwk) },
  });
}

/**
 * Issues the open mandate as a dSD-JWT whose KB-SD-JWT+KB, signed by the holder key, carries
 * `payloadSd` as its only delegate payload and the passkey assertion as `user_auth`.
 * @see https://datatracker.ietf.org/doc/html/draft-ietf-oauth-delegate-sd-jwt-00
 */
export async function issueOpenMandate(
  params: OpenMandateParams,
  signer: CryptoKey,
): Promise<string> {
  const { userCredential, payloadSd, disclosures, userAuth, aud, nonce } = params;
  if (!userCredential.endsWith("~") || userCredential.endsWith("~~")) {
    throw new RangeError("userCredential must be an SD-JWT without key binding");
  }
  jwkOf((payloadSd as { cnf?: unknown }).cnf);
  assertUserAuth(userAuth);
  const delegate = await pack(
    { delegate_payload: [payloadSd] },
    { delegate_payload: { _sd: [0] } },
    { hasher: sdHasher, alg: "sha-256" },
    salt,
  );
  const kbSdJwt = await new Jwt({
    header: { typ: OPEN_MANDATE_TYP, alg: "ES256" },
    payload: {
      ...delegate.packedClaims,
      _sd_alg: "sha-256",
      iat: Math.floor(Date.now() / 1000),
      aud,
      nonce,
      sd_hash: sdHash(userCredential),
      user_auth: userAuth,
    },
  }).sign(es256Signer(signer));
  const all = [...delegate.disclosures.map((d) => d.encode()), ...disclosures];
  return `${userCredential}~${kbSdJwt}~${all.map((d) => `${d}~`).join("")}`;
}

async function verifyUserCredential(token: string, key: CryptoKey): Promise<VerifiedCredential> {
  const parts = token.split("~");
  if (parts.at(-1) !== "" || parts.slice(0, -1).includes("")) {
    throw new RangeError("not an SD-JWT without key binding");
  }
  const { header, payload: claims } = await new SDJwtVcInstance({
    verifier: es256Verifier(key),
    hasher: sdHasher,
  }).verify(token, { allowedIssuerAlgorithms: ["ES256"], expectedVct: USER_CREDENTIAL_VCT });
  if (header?.typ !== USER_CREDENTIAL_TYP) throw new RangeError("unexpected typ");
  jwkOf(claims.cnf);
  return { header, payload: Jwt.decodeJWT(parts[0] as string).payload, claims };
}

/** Verifies a dSD-JWT as in section 6 of draft-ietf-oauth-delegate-sd-jwt-00, with one delegation. */
async function verifyOpenMandate(token: string, key: CryptoKey): Promise<VerifiedOpenMandate> {
  const parts = token.split("~");
  const split = parts.indexOf("");
  if (split < 1 || parts.at(-1) !== "" || parts.slice(split + 1, -1).includes("")) {
    throw new RangeError("not a dSD-JWT");
  }
  const sdJwt = `${parts.slice(0, split).join("~")}~`;
  const [kbJwt, ...rest] = parts.slice(split + 1);
  const userCredential = await verifyUserCredential(sdJwt, key);
  const holderKey = (await importJWK(jwkOf(userCredential.claims.cnf), "ES256")) as CryptoKey;
  const { header, payload: claims } = await new SDJwtInstance({
    verifier: es256Verifier(holderKey),
    hasher: sdHasher,
  }).verify(`${kbJwt}~${rest.join("~")}`, { allowedIssuerAlgorithms: ["ES256"] });
  if (header?.typ !== OPEN_MANDATE_TYP) throw new RangeError("unexpected typ");
  const signed = Jwt.decodeJWT(kbJwt as string).payload;
  if (
    typeof signed.iat !== "number" ||
    typeof signed.aud !== "string" ||
    typeof signed.nonce !== "string" ||
    signed.sd_hash !== sdHash(sdJwt)
  ) {
    throw new RangeError("invalid key binding");
  }
  const slot = (signed.delegate_payload as { "..."?: string }[] | undefined)?.[0]?.["..."];
  const delegates = claims.delegate_payload as Record<string, unknown>[] | undefined;
  if ((signed.delegate_payload as unknown[]).length !== 1 || delegates?.length !== 1) {
    throw new RangeError("expected exactly one disclosed delegate payload");
  }
  const disclosure = rest
    .slice(0, -1)
    .map((d) => Disclosure.fromEncodeSync(d, { hasher: sdHasher, alg: "sha-256" }))
    .find((d) => d._digest === slot);
  const delegate = delegates[0] as Record<string, unknown>;
  jwkOf(delegate.cnf);
  validateJwtPayload(delegate);
  assertUserAuth(claims.user_auth);
  return {
    header,
    payload: disclosure?.value as Record<string, unknown>,
    claims: delegate,
    userAuth: claims.user_auth,
    userCredential,
  };
}

/**
 * Verifies a user credential (RFC 9901 section 7.1) or an open mandate against the issuer's
 * public key and returns the signed payload and the disclosed claims. For an open mandate these
 * are the delegate payload's, and the holder key is taken from the user credential's `cnf`.
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
): Promise<VerifiedOpenMandate>;
export function verifyCredential(
  token: string,
  expectedTyp: typeof USER_CREDENTIAL_TYP | typeof OPEN_MANDATE_TYP,
  publicKey: CryptoKey,
): Promise<VerifiedCredential> {
  return expectedTyp === USER_CREDENTIAL_TYP
    ? verifyUserCredential(token, publicKey)
    : verifyOpenMandate(token, publicKey);
}
