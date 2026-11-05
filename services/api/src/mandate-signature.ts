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

/**
 * Verifies a passkey assertion over the mandate challenge
 * `M = SHA-256("keelson/mandate-challenge/v1" || 0x00 || H_sd || C_m)`. `cm` is taken from the
 * caller: the salt behind `C_m` never reaches the server. User verification is required, and the
 * client data may come from WebAuthn (`webauthn.get`) or Secure Payment Confirmation
 * (`payment.get`). The signature counter must increase unless the authenticator reports zero.
 * Cross-origin (framed) assertions are refused. For `payment.get`, the payment data the browser
 * showed must be `spc`, the SPC details derived from the mandate (SPC section "Verifying an
 * Authentication Assertion").
 */
export async function verifyMandateSignature(args: {
  payloadSd: object;
  cm: bigint;
  assertion: SignedChallenge;
  passkey: Passkey;
  expectedOrigin: string;
  expectedRpId: string;
  spc: SpcDetails;
}): Promise<{ M: Uint8Array; newCounter: number }> {
  const M = mandateChallenge(hSd(args.payloadSd), args.cm);
  const { credentialId, ...response } = args.assertion;
  checkClientData(args.assertion.clientDataJSON, args);
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
  payment?: {
    rpId?: unknown;
    topOrigin?: unknown;
    payeeName?: unknown;
    payeeOrigin?: unknown;
    total?: { currency?: unknown; value?: unknown };
    instrument?: { displayName?: unknown; icon?: unknown };
  };
}

function checkClientData(
  clientDataJSON: string,
  expected: { expectedOrigin: string; expectedRpId: string; spc: SpcDetails },
): void {
  let data: CollectedClientData;
  try {
    data = JSON.parse(isoBase64URL.toUTF8String(clientDataJSON)) as CollectedClientData;
  } catch {
    throw new SignatureError("clientDataJSON is not JSON");
  }
  if (data.crossOrigin === true) throw new SignatureError("cross-origin assertion");
  if (data.type !== "payment.get") return;
  const p = data.payment;
  const { spc } = expected;
  if (
    p?.rpId !== expected.expectedRpId ||
    p.topOrigin !== expected.expectedOrigin ||
    p.payeeName !== spc.payeeName ||
    p.payeeOrigin !== spc.payeeOrigin ||
    p.total?.currency !== spc.total.currency ||
    p.total.value !== spc.total.value ||
    p.instrument?.displayName !== SPC_INSTRUMENT.displayName ||
    p.instrument.icon !== SPC_INSTRUMENT.icon
  ) {
    throw new SignatureError("payment data differs from the mandate");
  }
}
