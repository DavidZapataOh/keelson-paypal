import { describe, expect, it } from "vitest";
import { purchaseFacts } from "../src/facts.ts";
import { disclosedPayload, hashB64u, jwtPayload } from "../src/jose.ts";
import {
  checkoutMandate,
  MerchantAuthorizationError,
  signMerchantAuthorization,
  ucpCheckout,
  verifyMerchantAuthorization,
} from "../src/ucp.ts";
import { ALLOWED, alibi, freshSigner } from "./fixtures.ts";
import { ajv, errors } from "./schemas.ts";

const CHECKOUT =
  "https://ucp.dev/schemas/common/payment_ap2_mandate.json#/$defs/dev.ucp.shopping.checkout";
const MANDATE = "https://ucp.dev/schemas/common/payment_ap2_mandate.json#/$defs/checkout_mandate";

describe("UCP 2026-08-25 with AP2 mandates", () => {
  it("states the purchase as a Checkout the AP2 extension's schema accepts", async () => {
    const business = await freshSigner();
    const signed = await signMerchantAuthorization(
      ucpCheckout(purchaseFacts(alibi(ALLOWED))),
      business,
    );
    expect(errors(CHECKOUT, signed)).toEqual([]);
  });

  it("verifies a business's merchant_authorization, as the spec's verify_merchant_authorization", async () => {
    const business = await freshSigner();
    const signed = await signMerchantAuthorization(
      ucpCheckout(purchaseFacts(alibi(ALLOWED))),
      business,
    );
    const keys = [{ ...business.jwk, kid: business.kid }];
    await expect(verifyMerchantAuthorization(signed, keys)).resolves.toBeUndefined();
    // Members are signed through JCS, so their order does not matter.
    const reordered = Object.fromEntries(Object.entries(signed).reverse());
    await expect(verifyMerchantAuthorization(reordered, keys)).resolves.toBeUndefined();
  });

  it("refuses a changed total, an unknown kid and a missing signature", async () => {
    const business = await freshSigner();
    const signed = await signMerchantAuthorization(
      ucpCheckout(purchaseFacts(alibi(ALLOWED))),
      business,
    );
    const keys = [{ ...business.jwk, kid: business.kid }];
    const changed = {
      ...signed,
      totals: [
        { type: "subtotal", amount: 1 },
        { type: "total", amount: 1 },
      ],
    };
    await expect(verifyMerchantAuthorization(changed, keys)).rejects.toMatchObject({
      code: "merchant_authorization_invalid",
    });
    await expect(
      verifyMerchantAuthorization(signed, [{ ...business.jwk, kid: "other" }]),
    ).rejects.toBeInstanceOf(MerchantAuthorizationError);
    const { ap2: _, ...unsigned } = signed;
    await expect(verifyMerchantAuthorization(unsigned, keys)).rejects.toMatchObject({
      code: "merchant_authorization_missing",
    });
  });

  // The extension's `checkout_mandate` pattern admits no `.` after a `~`, so no RFC 9901 SD-JWT+KB
  // (whose KB-JWT is a compact JWS) matches it; the token is checked against RFC 9901 instead.
  it("issues the complete request's checkout_mandate as an RFC 9901 SD-JWT+KB over the full checkout", async () => {
    const platform = await freshSigner();
    const agent = await freshSigner();
    const checkout = ucpCheckout(purchaseFacts(alibi(ALLOWED)));
    const token = await checkoutMandate(checkout, platform, {
      iat: 1_794_219_430,
      agent,
      aud: "https://runfast.example",
      nonce: "n-1",
    });
    const kb = token.slice(token.lastIndexOf("~") + 1);
    const presented = token.slice(0, token.lastIndexOf("~") + 1);
    expect(jwtPayload(kb)).toEqual({
      iat: 1_794_219_430,
      aud: "https://runfast.example",
      nonce: "n-1",
      sd_hash: hashB64u(presented),
    });
    const mandate = disclosedPayload<{ delegate_payload: { vct: string; checkout_jwt: string }[] }>(
      presented,
    ).delegate_payload[0];
    expect(mandate?.vct).toBe("mandate.checkout.1");
    expect(jwtPayload(mandate?.checkout_jwt as string)).toEqual(checkout);
    expect(ajv.getSchema(MANDATE)?.(token)).toBe(false);
  });
});
