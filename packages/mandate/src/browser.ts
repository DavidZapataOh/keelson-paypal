import { type AuthenticationResponseJSON, startAuthentication } from "@simplewebauthn/browser";

/** The WebAuthn assertion fields the server verifies, base64url-encoded as in `AuthenticationResponseJSON`. */
export interface SignedChallenge {
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
  credentialId: string;
  userHandle?: string;
}

export interface SpcOptions {
  payeeName: string;
  payeeOrigin: string;
  total: { currency: string; value: string };
}

const RP_ID = "keelson.finance";
const TIMEOUT_MS = 120_000;
const INSTRUMENT_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' rx='6' fill='%23111'/%3E%3C/svg%3E";

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

/**
 * Signs `challenge` with a registered passkey, requiring user verification. With `opts.spc` and a
 * browser that supports Secure Payment Confirmation, the browser shows the payee and total in its own
 * confirmation dialog; otherwise this is a plain WebAuthn assertion.
 */
export async function signMandate(
  challenge: Uint8Array,
  credentialIds: string[],
  opts?: { spc?: SpcOptions },
): Promise<SignedChallenge> {
  if (opts?.spc && (await spcAvailable())) {
    const { payeeName, payeeOrigin, total } = opts.spc;
    const request = new PaymentRequest(
      [
        {
          supportedMethods: "secure-payment-confirmation",
          data: {
            credentialIds: credentialIds.map(fromBase64Url),
            challenge: Uint8Array.from(challenge),
            rpId: RP_ID,
            instrument: { displayName: "Keelson mandate", icon: INSTRUMENT_ICON },
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
