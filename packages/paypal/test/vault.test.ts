import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { newId } from "@keelson/core";
import type { PaymentTokenResponse } from "@paypal/paypal-server-sdk";
import { describe, expect, it } from "vitest";
import { holdOrderRequest } from "../src/hold.ts";
import {
  savedWallet,
  VaultError,
  vaultedHoldOrder,
  WALLET_DESCRIPTION,
  walletPaymentTokenRequest,
  walletSetupTokenRequest,
} from "../src/vault.ts";

// PayPal sandbox answers as the SDK returns them, sanitized (ids, email and payer replaced).
const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`fixtures/vault/${name}.json`, import.meta.url), "utf8")) as T;

const urls = {
  returnUrl: "https://app.keelson.finance/passkeys",
  cancelUrl: "https://app.keelson.finance/passkeys",
};

describe("walletSetupTokenRequest", () => {
  it("asks for one merchant token of a consumer, billed upfront on the mandate's terms", () => {
    const req = walletSetupTokenRequest(urls);
    expect(req.customer).toBeUndefined();
    expect(req.paymentSource.paypal).toEqual({
      description: WALLET_DESCRIPTION,
      usagePattern: "UNSCHEDULED_PREPAID",
      usageType: "MERCHANT",
      customerType: "CONSUMER",
      permitMultiplePaymentTokens: false,
      experienceContext: {
        ...urls,
        shippingPreference: "NO_SHIPPING",
        userAction: "SETUP_NOW",
        locale: "en-US",
      },
    });
  });

  it("names the PayPal customer the user already is", () => {
    expect(walletSetupTokenRequest({ ...urls, customerId: "ROaPMoZUa5" }).customer).toEqual({
      id: "ROaPMoZUa5",
    });
  });

  it("describes the agreement within PayPal's 128 characters", () => {
    expect(WALLET_DESCRIPTION.length).toBeLessThanOrEqual(128);
  });
});

describe("walletPaymentTokenRequest", () => {
  it("exchanges the approved setup token", () => {
    expect(walletPaymentTokenRequest("5C991763VB2781612")).toEqual({
      paymentSource: { token: { id: "5C991763VB2781612", type: "SETUP_TOKEN" } },
    });
  });
});

describe("vaultedHoldOrder", () => {
  const order = holdOrderRequest({
    env: "s",
    mid: newId(),
    mandateHash: new Uint8Array(randomBytes(32)),
    amount: { currency: "USD", minor: 10_000n },
    ...urls,
  });

  it("keeps the request id and the purchase unit, and pays with the saved PayPal", () => {
    const vaulted = vaultedHoldOrder(order, "jwgvx42");
    expect(vaulted.paypalRequestId).toBe(order.paypalRequestId);
    expect(vaulted.body.intent).toBe("AUTHORIZE");
    expect(vaulted.body.purchaseUnits).toEqual(order.body.purchaseUnits);
    expect(vaulted.body.paymentSource).toEqual({
      paypal: {
        vaultId: "jwgvx42",
        storedCredential: { paymentInitiator: "MERCHANT", usagePattern: "UNSCHEDULED_PREPAID" },
      },
    });
  });

  it("leaves the order it was given as it was", () => {
    vaultedHoldOrder(order, "jwgvx42");
    expect(order.body.paymentSource?.paypal?.experienceContext).toBeDefined();
  });
});

describe("savedWallet", () => {
  it("reads the token, the PayPal customer and the email", () => {
    expect(savedWallet(fixture<PaymentTokenResponse>("payment-token"))).toEqual({
      vaultId: "8gk43s4",
      customerId: "kh4Wd1FbMx",
      email: "buyer@example.com",
    });
  });

  it("refuses a token without an id or a customer", () => {
    const token = fixture<PaymentTokenResponse>("payment-token");
    const { id: _, ...withoutId } = token;
    expect(() => savedWallet(withoutId)).toThrow(VaultError);
    expect(() => savedWallet({ ...token, customer: {} })).toThrow(VaultError);
  });
});
