import { type AuthenticationResponseJSON, startAuthentication } from "@simplewebauthn/browser";
import { RP_ID, SPC_INSTRUMENT, type SpcDetails } from "./spc.ts";

/** The WebAuthn assertion fields the server verifies, base64url-encoded as in `AuthenticationResponseJSON`. */
export interface SignedChallenge {
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
  credentialId: string;
  userHandle?: string;
}

/** The `spc` of `prepareSigning`. */
export type SpcOptions = SpcDetails;

/** One of the user's passkeys, as `GET /v1/passkeys` lists it. */
export interface PasskeyRef {
  credentialId: string;
  /** Registered with the SPC `payment` extension, so SPC can use it. */
  payment: boolean;
}

const TIMEOUT_MS = 120_000;

const toBase64Url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const fromBase64Url = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

type SpcPaymentRequest = typeof PaymentRequest & {
  securePaymentConfirmationAvailability?: () => Promise<string>;
};

async function spcAvailable(): Promise<boolean> {
  const request = globalThis.PaymentRequest as SpcPaymentRequest | undefined;
  return (await request?.securePaymentConfirmationAvailability?.()) === "available";
}

/** Per-request passkey registration options: universal unless SPC can be used on this device. */
export interface RegistrationOptions {
  authenticatorAttachment?: "platform";
}

/**
 * Registration options for a new passkey. Any authenticator (security key, phone, platform) can
 * register. When the browser supports Secure Payment Confirmation and has a user-verifying
 * platform authenticator, the passkey is created there; the server then issues the SPC `payment`
 * extension and records the passkey as payment-capable.
 */
export async function passkeyRegistrationOptions(): Promise<RegistrationOptions> {
  const platform =
    (await globalThis.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.()) ===
    true;
  if (!platform || !(await spcAvailable())) return {};
  return { authenticatorAttachment: "platform" };
}

const isNotSupported = (e: unknown): boolean =>
  e instanceof DOMException && e.name === "NotSupportedError";

async function signWithSpc(
  challenge: Uint8Array,
  credentialIds: string[],
  { payeeName, payeeOrigin, total }: SpcOptions,
): Promise<SignedChallenge> {
  const request = new PaymentRequest(
    [
      {
        supportedMethods: "secure-payment-confirmation",
        data: {
          credentialIds: credentialIds.map(fromBase64Url),
          challenge: Uint8Array.from(challenge),
          rpId: RP_ID,
          instrument: { ...SPC_INSTRUMENT },
          payeeName,
          payeeOrigin,
          timeout: TIMEOUT_MS,
        },
      },
    ],
    { total: { label: "Total", amount: total } },
  );
  const response = await request.show();
  await response.complete("success");
  return fromCredential(
    (response.details as PublicKeyCredential).toJSON() as unknown as AuthenticationResponseJSON,
  );
}

/**
 * Signs `challenge` with one of `passkeys`, requiring user verification. With `opts.spc` (the
 * `spc` of `prepareSigning`), a browser that supports Secure Payment Confirmation and at least one
 * payment-capable passkey, the browser shows the payee and total in its own confirmation dialog
 * and only those passkeys are offered. Otherwise, or when SPC is unsupported, a plain WebAuthn
 * assertion is requested from every passkey; a cancelled or failed SPC prompt is never retried.
 */
export async function signMandate(
  challenge: Uint8Array,
  passkeys: readonly PasskeyRef[],
  opts?: { spc?: SpcOptions },
): Promise<SignedChallenge> {
  const payment = passkeys.filter((p) => p.payment).map((p) => p.credentialId);
  if (opts?.spc && payment.length > 0 && (await spcAvailable())) {
    try {
      return await signWithSpc(challenge, payment, opts.spc);
    } catch (e) {
      if (!isNotSupported(e)) throw e;
    }
  }
  const assertion = await startAuthentication({
    optionsJSON: {
      challenge: toBase64Url(challenge),
      rpId: RP_ID,
      userVerification: "required",
      timeout: TIMEOUT_MS,
      allowCredentials: passkeys.map((p) => ({ id: p.credentialId, type: "public-key" })),
    },
  });
  return fromCredential(assertion);
}

function fromCredential(c: AuthenticationResponseJSON): SignedChallenge {
  const { authenticatorData, clientDataJSON, signature, userHandle } = c.response;
  return {
    authenticatorData,
    clientDataJSON,
    signature,
    credentialId: c.id,
    ...(userHandle ? { userHandle } : {}),
  };
}
