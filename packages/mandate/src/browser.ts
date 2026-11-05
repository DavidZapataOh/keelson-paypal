/**
 * The signing API for the user app. A mandate is signed in this order:
 *
 * 1. Register a passkey: `const opts = await passkeyRegistrationOptions()`, then Better Auth's
 *    `authClient.passkey.addPasskey({ ...opts })`. When `opts.authenticatorAttachment` is
 *    `"platform"`, call `rememberPaymentPasskey(data.credentialID)` so this device signs through
 *    Secure Payment Confirmation; skipping it only falls back to plain WebAuthn.
 * 2. `const s = await prepareSigning(mandate, salt, evidence)` and show `s.card` to the user.
 * 3. Fetch the user's `passkeys` from `GET /v1/passkeys` (with credentials).
 * 4. `const assertion = await signMandate(s.challenge, passkeys, { spc: s.spc })`.
 * 5. `POST /v1/mandates` (with credentials) with an `Idempotency-Key` header and the body
 *    `{ payloadSd: s.payloadSd, disclosures: s.disclosures, commitment: s.commitment, assertion }`.
 *
 * The mandate code and Poseidon2 (bb.js and its wasm) load on the first `prepareSigning`, not with
 * this module.
 *
 * @module
 */
import { type AuthenticationResponseJSON, startAuthentication } from "@simplewebauthn/browser";
import type { Signing } from "./card.ts";
import type { Evidence } from "./colors.ts";
import type { Mandate } from "./schema.ts";
import { RP_ID, SPC_INSTRUMENT, type SpcDetails } from "./spc.ts";

export type { Card, CardRow, Signing } from "./card.ts";
export type { Evidence } from "./colors.ts";
export type { Mandate } from "./schema.ts";
export type { SpcDetails } from "./spc.ts";

/**
 * Builds the payload, commitment, challenge, card and SPC details of `m`; see the card module's
 * `prepareSigning`. The mandate code and Poseidon2 load on the first call.
 */
export async function prepareSigning(
  m: Mandate,
  salt: Uint8Array,
  evidence: Evidence,
): Promise<Signing> {
  const card = await import("./card.ts");
  return card.prepareSigning(m, salt, evidence);
}

/** The WebAuthn assertion fields the server verifies, base64url-encoded as in `AuthenticationResponseJSON`. */
export interface SignedChallenge {
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
  credentialId: string;
  userHandle?: string;
}

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

const PAYMENT_PASSKEYS_KEY = "keelson.paymentCredentials";

function localPaymentPasskeys(): Set<string> {
  try {
    const ids: unknown = JSON.parse(globalThis.localStorage?.getItem(PAYMENT_PASSKEYS_KEY) ?? "[]");
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Records that this browser registered `credentialId` with the SPC `payment` extension, that is,
 * after registering with the platform options of {@link passkeyRegistrationOptions}. SPC is only
 * offered passkeys recorded here, so a payment passkey living on another device never hides the
 * passkeys usable on this one.
 */
export function rememberPaymentPasskey(credentialId: string): void {
  const ids = localPaymentPasskeys();
  ids.add(credentialId);
  globalThis.localStorage?.setItem(PAYMENT_PASSKEYS_KEY, JSON.stringify([...ids]));
}

const isNotSupported = (e: unknown): boolean =>
  e instanceof DOMException && e.name === "NotSupportedError";

async function signWithSpc(
  challenge: Uint8Array,
  credentialIds: string[],
  { payeeName, payeeOrigin, total }: SpcDetails,
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
 * passkey that is payment-capable and was registered in this browser
 * ({@link rememberPaymentPasskey}), the browser shows the payee and total in its own confirmation
 * dialog and only those passkeys are offered. Otherwise, or when SPC is unsupported, a plain
 * WebAuthn assertion is requested from every passkey; a cancelled or failed SPC prompt is never
 * retried.
 */
export async function signMandate(
  challenge: Uint8Array,
  passkeys: readonly PasskeyRef[],
  opts?: { spc?: SpcDetails },
): Promise<SignedChallenge> {
  const local = localPaymentPasskeys();
  const payment = passkeys
    .filter((p) => p.payment && local.has(p.credentialId))
    .map((p) => p.credentialId);
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
