import { type Json, jcs } from "@keelson/core";
import { base64url, flattenedVerify, importJWK, type JWK } from "jose";
import { checkoutObject } from "./ap2.ts";
import type { PurchaseFacts } from "./facts.ts";
import { disclose, hashB64u, ref, type Signer, sdJwt, signJwt } from "./jose.ts";

/**
 * UCP 2026-08-25 (github.com/Universal-Commerce-Protocol/ucp) with the AP2 Mandates extension
 * (`dev.ucp.common.payment.ap2_mandate`).
 */

export const UCP_VERSION = "2026-08-25";

/** A UCP Checkout object, `ap2` included when present. */
export type UcpCheckout = Record<string, unknown> & { ap2?: Record<string, unknown> };

/** The UCP checkout response of a purchase, as the business would have returned it. */
export function ucpCheckout(f: PurchaseFacts): UcpCheckout {
  const { merchant: _, ...checkout } = checkoutObject(f);
  return {
    ucp: {
      version: UCP_VERSION,
      capabilities: {
        "dev.ucp.shopping.checkout": [{ version: UCP_VERSION }],
        "dev.ucp.common.payment.ap2_mandate": [
          { version: UCP_VERSION, extends: "dev.ucp.shopping.checkout" },
        ],
      },
      payment_handlers: {},
    },
    ...checkout,
  };
}

/** What `ap2.merchant_authorization` signs: JCS (RFC 8785) of the checkout without `ap2`. */
const signedBytes = (checkout: UcpCheckout): Uint8Array => {
  const { ap2: _, ...payload } = checkout;
  return new TextEncoder().encode(jcs(payload as Json));
};

/**
 * Signs a checkout as its business: `ap2.merchant_authorization` is a JWS with detached content
 * (RFC 7515 Appendix F), `<header>..<signature>`, over the checkout without `ap2`.
 */
export async function signMerchantAuthorization(
  checkout: UcpCheckout,
  business: Signer,
): Promise<UcpCheckout> {
  const header = base64url.encode(JSON.stringify({ alg: "ES256", kid: business.kid }));
  const input = `${header}.${base64url.encode(signedBytes(checkout))}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      business.key,
      new TextEncoder().encode(input),
    ),
  );
  return {
    ...checkout,
    ap2: { ...checkout.ap2, merchant_authorization: `${header}..${base64url.encode(signature)}` },
  };
}

/** Why {@link verifyMerchantAuthorization} refused a checkout, as the AP2 extension's error codes. */
export class MerchantAuthorizationError extends Error {
  readonly code: "merchant_authorization_missing" | "merchant_authorization_invalid";

  constructor(code: MerchantAuthorizationError["code"], message: string) {
    super(message);
    this.name = "MerchantAuthorizationError";
    this.code = code;
  }
}

const ALGORITHMS = ["ES256", "ES384", "ES512"];

/**
 * Verifies `ap2.merchant_authorization` against the business's `keys` (its `/.well-known/ucp`
 * profile), selected by the header's `kid`.
 */
export async function verifyMerchantAuthorization(
  checkout: UcpCheckout,
  keys: readonly JWK[],
): Promise<void> {
  const jws = checkout.ap2?.merchant_authorization;
  if (typeof jws !== "string")
    throw new MerchantAuthorizationError(
      "merchant_authorization_missing",
      "no ap2.merchant_authorization",
    );
  const [protectedHeader = "", empty, signature = ""] = jws.split(".");
  if (empty !== "" || jws.split(".").length !== 3) {
    throw new MerchantAuthorizationError("merchant_authorization_invalid", "not a detached JWS");
  }
  const header = JSON.parse(new TextDecoder().decode(base64url.decode(protectedHeader))) as {
    alg?: string;
    kid?: string;
  };
  const key = keys.find((k) => k.kid === header.kid);
  if (!header.alg || !ALGORITHMS.includes(header.alg) || !key) {
    throw new MerchantAuthorizationError(
      "merchant_authorization_invalid",
      "unknown key or algorithm",
    );
  }
  try {
    await flattenedVerify(
      { protected: protectedHeader, payload: base64url.encode(signedBytes(checkout)), signature },
      await importJWK(key, header.alg),
      { algorithms: [header.alg] },
    );
  } catch {
    throw new MerchantAuthorizationError(
      "merchant_authorization_invalid",
      "the signature does not verify",
    );
  }
}

/**
 * The `ap2.checkout_mandate` of a `complete_checkout` request, in UCP's Trusted Platform Provider
 * model: an SD-JWT signed by the platform whose `mandate.checkout.1` carries the full checkout
 * (with `ap2.merchant_authorization` when the business signed it) as `checkout_jwt`, key-bound to
 * the agent when its key signs the KB-JWT (SD-JWT+KB, RFC 9901 section 4.3).
 */
export async function checkoutMandate(
  checkout: UcpCheckout,
  platform: Signer,
  opts: { iat: number; agent?: Signer; aud?: string; nonce?: string },
): Promise<string> {
  const checkoutJwt = await signJwt({ typ: "JWT", kid: platform.kid }, checkout, platform);
  const field = disclose(checkoutJwt, "checkout_jwt");
  const mandate = disclose({
    vct: "mandate.checkout.1",
    _sd: [field.digest],
    checkout_hash: hashB64u(checkoutJwt),
  });
  const jwt = await signJwt(
    { typ: "dc+sd-jwt", kid: platform.kid },
    {
      iss: "https://keelson.finance",
      iat: opts.iat,
      delegate_payload: [ref(mandate)],
      ...(opts.agent ? { cnf: { jwk: { ...opts.agent.jwk, kid: opts.agent.kid } } } : {}),
      _sd_alg: "sha-256",
    },
    platform,
  );
  const token = sdJwt(jwt, [mandate, field]);
  if (!opts.agent) return token;
  const kb = await signJwt(
    { typ: "kb+jwt", kid: opts.agent.kid },
    {
      iat: opts.iat,
      aud: opts.aud ?? "merchant",
      nonce: opts.nonce ?? checkout.id,
      sd_hash: hashB64u(token),
    },
    opts.agent,
  );
  return `${token}${kb}`;
}
