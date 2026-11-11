import { type Json, jcs } from "@keelson/core";
import { base64url, decodeProtectedHeader, FlattenedSign, flattenedVerify, importJWK } from "jose";
import { checkoutObject, exportAp2, keelsonClaim, verifyAp2Chain } from "./ap2.ts";
import { transform } from "./bindings.ts";
import type { PurchaseFacts, StatementFacts } from "./facts.ts";
import { issuedBy, jwtPayload } from "./jose.ts";
import { type AgentSigner, type EcPublicJwk, ExportRefused, type ExportSigner } from "./signer.ts";
import type { AlibiRef } from "./statement.ts";
import type { CheckId, ExportReport } from "./verify.ts";

export const UCP_VERSION = "2026-08-25";
/** The export profile of the issuer's attestation over a UCP checkout. */
export const UCP_CHECKOUT = "ucp.checkout/1";
/** The reverse-domain signal that carries the purchase's SCITT Transparent Statement. */
export const ALIBI_SIGNAL = "finance.keelson.alibi";

/** A purchase as a UCP checkout, with the AP2 checkout mandate that completes it. */
export interface UcpExport {
  type: "keelson.ucp/1";
  version: typeof UCP_VERSION;
  alibi: AlibiRef;
  checkout: Record<string, unknown>;
  complete_request: { ap2: { checkout_mandate: string } };
  /** The issuer's compact JWS over `{ checkout, keelson }`. */
  attestation: string;
}

/** The UCP checkout response for a purchase, with its statement as a signal. */
export function ucpCheckout(f: PurchaseFacts, ref: AlibiRef): Record<string, unknown> {
  return {
    ucp: { version: UCP_VERSION, payment_handlers: {} },
    ...checkoutObject(f),
    signals: { [ALIBI_SIGNAL]: ref.statement },
  };
}

/**
 * The checkout and the closed AP2 checkout mandate, signed by the issuer and the agent. UCP
 * requires a subtotal, which only a disclosed cart or checkout breakdown states.
 */
export async function exportUcp(
  f: PurchaseFacts,
  ref: AlibiRef,
  k: { issuer: ExportSigner; agent: AgentSigner },
  o: { now: number },
): Promise<UcpExport> {
  if (!f.lines && !f.breakdown) throw new ExportRefused("no_cart");
  const ap2 = await exportAp2(f, ref, k, o);
  const checkout = ucpCheckout(f, ref);
  const attestation = await k.issuer.sign(
    "JWT",
    { checkout, keelson: keelsonClaim(f, ref, UCP_CHECKOUT) },
    ref.statement,
  );
  return {
    type: "keelson.ucp/1",
    version: UCP_VERSION,
    alibi: ref,
    checkout,
    complete_request: { ap2: { checkout_mandate: ap2.checkout.closed as string } },
    attestation,
  };
}

/** Why a merchant authorization does not verify. */
export class MerchantAuthorizationError extends Error {
  readonly code: "format" | "not_detached" | "kid" | "signature";

  constructor(code: MerchantAuthorizationError["code"]) {
    super(code);
    this.name = "MerchantAuthorizationError";
    this.code = code;
  }
}

const encoder = new TextEncoder();
const bodyOf = (checkout: Record<string, unknown>) => {
  const { ap2: _, ...rest } = checkout;
  return encoder.encode(jcs(rest as Json));
};

/**
 * `ap2.merchant_authorization`: a JWS with detached content (RFC 7515 Appendix F) over the RFC 8785
 * canonical checkout without `ap2`, as UCP's AP2 mandates extension defines it.
 */
export async function signMerchantAuthorization(
  checkout: Record<string, unknown>,
  merchant: AgentSigner,
): Promise<string> {
  const jws = await new FlattenedSign(bodyOf(checkout))
    .setProtectedHeader({ alg: "ES256", kid: merchant.jwk.kid })
    .sign(merchant.key);
  return `${jws.protected}..${jws.signature}`;
}

/** Verifies a checkout's `ap2.merchant_authorization` against the merchant's keys. */
export async function verifyMerchantAuthorization(
  checkout: Record<string, unknown> & { ap2?: { merchant_authorization?: string } },
  keys: { keys: EcPublicJwk[] },
): Promise<void> {
  const parts = checkout.ap2?.merchant_authorization?.split(".") ?? [];
  if (parts.length !== 3) throw new MerchantAuthorizationError("format");
  const [protectedHeader, payload, signature] = parts as [string, string, string];
  if (payload !== "") throw new MerchantAuthorizationError("not_detached");
  const { kid, alg } = decodeProtectedHeader(`${protectedHeader}..${signature}`);
  const jwk = keys.keys.find((k) => k.kid === kid);
  if (!jwk || alg !== "ES256") throw new MerchantAuthorizationError("kid");
  try {
    await flattenedVerify(
      { protected: protectedHeader, payload: base64url.encode(bodyOf(checkout)), signature },
      await importJWK(jwk, "ES256"),
    );
  } catch {
    throw new MerchantAuthorizationError("signature");
  }
}

/**
 * Verifies a UCP export offline: the issuer's attestation over the checkout, the checkout's
 * totals against the statement facts, and the AP2 checkout mandate as a delegated chain.
 */
export async function verifyUcp(
  x: UcpExport,
  o: { now: number; issuerKeys: EcPublicJwk[] },
): Promise<ExportReport> {
  const started = performance.now();
  const p = jwtPayload(x.attestation) as {
    checkout?: unknown;
    keelson?: { statement?: string; facts?: StatementFacts };
  };
  const facts = p.keelson?.facts;
  const totals = x.checkout.totals as { type: string; amount: number }[] | undefined;
  let binding = false;
  try {
    const chain = x.complete_request.ap2.checkout_mandate;
    const { kid } = decodeProtectedHeader(chain.split("~")[0] as string);
    const rootKey = o.issuerKeys.find((k) => k.kid === kid);
    if (rootKey && facts) {
      await verifyAp2Chain({
        chain,
        rootKey,
        currentTimeUnix: o.now,
        expectedAud: "merchant",
        expectedNonce: transform("UlidOfRequest", facts.request_id, facts) as string,
      });
      binding = true;
    }
  } catch {
    binding = false;
  }
  const checks: { id: CheckId; ok: boolean }[] = [
    { id: "issuer", ok: await issuedBy(x.attestation, o.issuerKeys) },
    {
      id: "signatures",
      ok:
        JSON.stringify(p.checkout) === JSON.stringify(x.checkout) &&
        p.keelson?.statement === x.alibi.statement &&
        (x.checkout.signals as Record<string, string> | undefined)?.[ALIBI_SIGNAL] ===
          x.alibi.statement,
    },
    {
      id: "facts",
      ok:
        facts !== undefined &&
        totals?.[0]?.type === "total" &&
        totals[0].amount === facts.amount_minor &&
        x.checkout.currency === transform("UpperCurrency", facts.currency, facts),
    },
    { id: "chain_binding", ok: binding },
  ];
  return { format: "ucp", ok: checks.every((c) => c.ok), checks, ms: performance.now() - started };
}
