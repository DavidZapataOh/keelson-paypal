import { type AuthenticationResponseJSON, startAuthentication } from "@simplewebauthn/browser";
import { SPC_INSTRUMENT, type SpcDetails } from "./spc.ts";

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

const RP_ID = "keelson.finance";
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
  extensions?: { payment: { isPayment: true } };
}

/**
 * Registration options for a new passkey. Any authenticator (security key, phone, platform) can
 * register; only when the browser supports Secure Payment Confirmation and has a user-verifying
 * platform authenticator is the passkey created there with the SPC `payment` extension, which
 * SPC requires.
 */
export async function passkeyRegistrationOptions(): Promise<RegistrationOptions> {
  const platform =
    (await globalThis.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.()) ===
    true;
  if (!platform || !(await spcAvailable())) return {};
  return { authenticatorAttachment: "platform", extensions: { payment: { isPayment: true } } };
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
 * Signs `challenge` with a registered passkey, requiring user verification. With `opts.spc`
 * (the `spc` of `prepareSigning`) and a browser that supports Secure Payment Confirmation, the
 * browser shows the payee and total in its own confirmation dialog. A plain WebAuthn assertion is
 * used only when SPC is unsupported; a cancelled or failed SPC prompt is never retried.
 */
export async function signMandate(
  challenge: Uint8Array,
  credentialIds: string[],
  opts?: { spc?: SpcOptions },
): Promise<SignedChallenge> {
  if (opts?.spc && (await spcAvailable())) {
    try {
      return await signWithSpc(challenge, credentialIds, opts.spc);
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
      allowCredentials: credentialIds.map((id) => ({ id, type: "public-key" })),
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
