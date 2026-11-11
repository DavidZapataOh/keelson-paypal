import { hSd, mandateChallenge, SPC_INSTRUMENT, type SpcDetails } from "@keelson/mandate";
import type { SignedChallenge } from "@keelson/mandate/browser";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { cose, decodeCredentialPublicKey, isoBase64URL } from "@simplewebauthn/server/helpers";
import type { Passkey } from "./passkeys.ts";

/** Thrown when the assertion does not verify; the message says why. */
export class SignatureError extends Error {
  override name = "SignatureError";
}

/** The P-256 point of a stored ES256 passkey, as base64url JWK coordinates. */
export function passkeyJwk(passkey: Pick<Passkey, "publicKey">): { x: string; y: string } {
  const key = decodeCredentialPublicKey(
    isoBase64URL.toBuffer(passkey.publicKey, "base64"),
  ) as cose.COSEPublicKeyEC2;
  const x = key.get(cose.COSEKEYS.x);
  const y = key.get(cose.COSEKEYS.y);
  if (key.get(cose.COSEKEYS.alg) !== cose.COSEALG.ES256 || !x || !y) {
    throw new SignatureError("passkey is not ES256");
  }
  return { x: isoBase64URL.fromBuffer(x), y: isoBase64URL.fromBuffer(y) };
}

/** Upper bounds on the decoded assertion fields, far above what a browser produces. */
const MAX_CLIENT_DATA_JSON = 4096;
const MAX_AUTHENTICATOR_DATA = 1024;
const MAX_SIGNATURE = 80;
/** `rpIdHash`, flags and counter, without attested credential data or extensions. */
const AUTH_DATA_LENGTH = 37;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;

/** Decodes base64url of at most `max` bytes, refusing longer input before decoding it. */
function decodeBounded(s: string, max: number, name: string): Uint8Array {
  if (s.length > Math.ceil(max / 3) * 4) throw new SignatureError(`${name} is too large`);
  let bytes: Uint8Array;
  try {
    bytes = isoBase64URL.toBuffer(s);
  } catch {
    throw new SignatureError(`${name} is not base64url`);
  }
  if (bytes.length > max) throw new SignatureError(`${name} is too large`);
  return bytes;
}

/**
 * Verifies a passkey assertion over the mandate challenge
 * `M = SHA-256("keelson/mandate-challenge/v1" || 0x00 || H_sd || C_m)`. `cm` is taken from the
 * caller: the salt behind `C_m` never reaches the server. User verification is required, and the
 * client data may come from WebAuthn (`webauthn.get`) or Secure Payment Confirmation
 * (`payment.get`). The signature counter must increase unless the authenticator reports zero.
 * The assertion is cross-origin exactly when `expectedTopOrigin` is given: made in Keelson's approval
 * framed by that top-level origin, the mandate's `embed.top_origin`. Token binding, attested
 * credential data and extensions are refused, and input sizes are bounded. For `payment.get`, the
 * payment data the browser showed must be `spc`, the SPC details derived from the mandate (SPC
 * section "Verifying an Authentication Assertion").
 */
export async function verifyMandateSignature(args: {
  payloadSd: object;
  cm: bigint;
  assertion: SignedChallenge;
  passkey: Passkey;
  expectedOrigin: string;
  /** The embedding page's origin, for an assertion made in a frame. */
  expectedTopOrigin?: string | undefined;
  expectedRpId: string;
  spc: SpcDetails;
}): Promise<{ M: Uint8Array; newCounter: number }> {
  const M = mandateChallenge(hSd(args.payloadSd), args.cm);
  const { credentialId, ...response } = args.assertion;
  checkClientData(
    decodeBounded(args.assertion.clientDataJSON, MAX_CLIENT_DATA_JSON, "clientDataJSON"),
    args,
  );
  const authData = decodeBounded(
    args.assertion.authenticatorData,
    MAX_AUTHENTICATOR_DATA,
    "authenticatorData",
  );
  if (authData.length !== AUTH_DATA_LENGTH) {
    throw new SignatureError("authenticatorData is not 37 bytes");
  }
  if ((authData[32] as number) & (FLAG_AT | FLAG_ED)) {
    throw new SignatureError("authenticatorData has extension or credential data");
  }
  decodeBounded(args.assertion.signature, MAX_SIGNATURE, "signature");
  try {
    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response: {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response,
        clientExtensionResults: {},
      },
      expectedChallenge: isoBase64URL.fromBuffer(new Uint8Array(M)),
      expectedOrigin: args.expectedOrigin,
      expectedRPID: args.expectedRpId,
      expectedType: ["webauthn.get", "payment.get"],
      requireUserVerification: true,
      credential: {
        id: args.passkey.credentialID,
        publicKey: new Uint8Array(isoBase64URL.toBuffer(args.passkey.publicKey, "base64")),
        counter: args.passkey.counter,
      },
    });
    if (!verified) throw new SignatureError("signature did not verify");
    return { M, newCounter: authenticationInfo.newCounter };
  } catch (err) {
    if (err instanceof SignatureError) throw err;
    throw new SignatureError(err instanceof Error ? err.message : String(err));
  }
}

interface CollectedClientData {
  type?: unknown;
  crossOrigin?: unknown;
  topOrigin?: unknown;
  payment?: {
    paymentEntitiesLogos?: unknown;
    rpId?: unknown;
    topOrigin?: unknown;
    payeeName?: unknown;
    payeeOrigin?: unknown;
    total?: { currency?: unknown; value?: unknown };
    instrument?: { displayName?: unknown; icon?: unknown };
  };
}

/**
 * Whether the assertion's framing is the expected one (WebAuthn Level 3 section 7.2, steps 11 and
 * 12): at the top level `crossOrigin` is absent or `false` and `topOrigin` absent; in a frame
 * `crossOrigin` is `true` and `topOrigin` is the embedding page's origin.
 */
function framedAs(
  data: { crossOrigin?: unknown; topOrigin?: unknown },
  top?: string,
): boolean {
  if (top === undefined) {
    return (
      (!Object.hasOwn(data, "crossOrigin") || data.crossOrigin === false) &&
      !Object.hasOwn(data, "topOrigin")
    );
  }
  return data.crossOrigin === true && data.topOrigin === top;
}

function checkClientData(
  clientDataJSON: Uint8Array,
  expected: {
    expectedOrigin: string;
    expectedTopOrigin?: string | undefined;
    expectedRpId: string;
    spc: SpcDetails;
  },
): void {
  let data: CollectedClientData;
  try {
    data = JSON.parse(new TextDecoder().decode(clientDataJSON)) as CollectedClientData;
  } catch {
    throw new SignatureError("clientDataJSON is not a JSON object");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new SignatureError("clientDataJSON is not a JSON object");
  }
  if (!framedAs(data, expected.expectedTopOrigin)) {
    throw new SignatureError("cross-origin assertion");
  }
  if (Object.hasOwn(data, "tokenBinding"))
    throw new SignatureError("token binding is not supported");
  if (data.type !== "payment.get") return;
  const p = data.payment;
  const { spc } = expected;
  const logos = p?.paymentEntitiesLogos;
  if (
    p?.rpId !== expected.expectedRpId ||
    p.topOrigin !== (expected.expectedTopOrigin ?? expected.expectedOrigin) ||
    p.payeeName !== spc.payeeName ||
    p.payeeOrigin !== spc.payeeOrigin ||
    p.total?.currency !== spc.total.currency ||
    p.total.value !== spc.total.value ||
    p.instrument?.displayName !== SPC_INSTRUMENT.displayName ||
    p.instrument.icon !== SPC_INSTRUMENT.icon ||
    // No logos are shown, so none may be reported (SPC section 9.1).
    !(logos === undefined || (Array.isArray(logos) && logos.length === 0))
  ) {
    throw new SignatureError("payment data differs from the mandate");
  }
}
