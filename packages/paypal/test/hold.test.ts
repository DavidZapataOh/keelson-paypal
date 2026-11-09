import { randomBytes } from "node:crypto";
import { DST, hashObject, newId, sha256, toHex } from "@keelson/core";
import {
  AuthorizationStatus,
  CheckoutPaymentIntent,
  type PaymentAuthorization,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
} from "@paypal/paypal-server-sdk";
import { describe, expect, it } from "vitest";
import { PayPalError } from "../src/errors.ts";
import {
  checkAuthorization,
  HoldMismatchError,
  holdCustomId,
  holdOrderRequest,
  isAuthorizationGone,
  purchaseHoldCustomId,
  purchaseHoldDigest,
  purchaseHoldOrderRequest,
} from "../src/hold.ts";
import { operationRequestId, parseCustomId } from "../src/ids.ts";

const RETURN_URL = "https://keelson.finance/return";
const CANCEL_URL = "https://keelson.finance/cancel";
const STORE = "A4WCRYD5EYDF2";
const hundred = { currency: "USD", minor: 10_000n } as const;
const bytes32 = () => new Uint8Array(randomBytes(32));

describe("holdCustomId", () => {
  it("is 77 characters and parses back to the mandate and its hash", () => {
    const mid = newId();
    const m = bytes32();
    const id = holdCustomId("s", mid, m);
    expect(id).toHaveLength(77);
    expect(parseCustomId(id)).toEqual({ env: "s", kind: "m", id: mid, digest: m });
  });

  it("changes with the mandate hash", () => {
    const mid = newId();
    expect(holdCustomId("s", mid, bytes32())).not.toBe(holdCustomId("s", mid, bytes32()));
  });
});

describe("purchaseHoldCustomId", () => {
  it("round-trips with kind a", () => {
    const requestId = newId();
    const d = bytes32();
    expect(parseCustomId(purchaseHoldCustomId("p", requestId, d))).toEqual({
      env: "p",
      kind: "a",
      id: requestId,
      digest: d,
    });
  });

  it("digests the mandate, the cart, the merchant and the amount", () => {
    const fields = {
      mandateHash: bytes32(),
      cartHash: bytes32(),
      merchantId: STORE,
      amount: hundred,
    };
    expect(purchaseHoldDigest(fields)).toEqual(
      hashObject(DST.alibi, {
        mandate_hash: toHex(fields.mandateHash),
        cart_hash: toHex(fields.cartHash),
        merchant_id: STORE,
        amount: "100.00",
        currency: "USD",
      }),
    );
    expect(
      purchaseHoldDigest({ ...fields, amount: { currency: "USD", minor: 10_001n } }),
    ).not.toEqual(purchaseHoldDigest(fields));
  });
});

describe("holdOrderRequest", () => {
  it("authorizes the budget under the mandate with an idempotent request id", () => {
    const mid = newId();
    const m = bytes32();
    const { paypalRequestId, body } = holdOrderRequest({
      env: "s",
      mid,
      mandateHash: m,
      amount: hundred,
      returnUrl: RETURN_URL,
      cancelUrl: CANCEL_URL,
    });
    expect(paypalRequestId).toBe(toHex(m).slice(2, 38));
    expect(body).toEqual({
      intent: CheckoutPaymentIntent.Authorize,
      purchaseUnits: [
        {
          referenceId: mid,
          customId: holdCustomId("s", mid, m),
          description: `Agent purchases under Keelson mandate ${mid}`,
          amount: { currencyCode: "USD", value: "100.00" },
        },
      ],
      paymentSource: {
        paypal: {
          experienceContext: {
            userAction: PaypalExperienceUserAction.PayNow,
            shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
            returnUrl: RETURN_URL,
            cancelUrl: CANCEL_URL,
            locale: "en-US",
          },
        },
      },
    });
  });
});

describe("purchaseHoldOrderRequest", () => {
  it("authorizes one cart under the request id with a description within 127 characters", () => {
    const mid = newId();
    const requestId = newId();
    const d = bytes32();
    const { paypalRequestId, body } = purchaseHoldOrderRequest({
      env: "s",
      requestId,
      digest: d,
      amount: { currency: "USD", minor: 4_250n },
      mid,
      merchantName: "Keelson Demo Store",
      returnUrl: RETURN_URL,
      cancelUrl: CANCEL_URL,
    });
    const customId = purchaseHoldCustomId("s", requestId, d);
    expect(paypalRequestId).toBe(toHex(sha256(new TextEncoder().encode(customId))).slice(2, 38));
    const other = purchaseHoldOrderRequest({
      env: "s",
      requestId: newId(),
      digest: d,
      amount: { currency: "USD", minor: 4_250n },
      mid,
      merchantName: "Keelson Demo Store",
      returnUrl: RETURN_URL,
      cancelUrl: CANCEL_URL,
    });
    expect(other.paypalRequestId).not.toBe(paypalRequestId);
    const unit = body.purchaseUnits[0];
    expect(body.intent).toBe(CheckoutPaymentIntent.Authorize);
    expect(unit?.referenceId).toBe(requestId);
    expect(unit?.customId).toBe(purchaseHoldCustomId("s", requestId, d));
    expect(unit?.amount).toEqual({ currencyCode: "USD", value: "42.50" });
    expect(unit?.description).toBe(
      `Agent purchase under Keelson mandate ${mid}; verify: verify.keelson.finance/a/${requestId}`,
    );
    expect(unit?.description?.length).toBeLessThanOrEqual(127);
    expect(body.paymentSource?.paypal?.experienceContext?.brandName).toBe("Keelson Demo Store");
  });
});

describe("operationRequestId", () => {
  it("matches the request ids already sent to the sandbox", () => {
    expect(operationRequestId("X", "void")).toBe("c8683d83c1b6244c83d9a1aa3155053240ca");
    expect(operationRequestId("X", "authorize")).toBe("882ac9106d3d2022fb653b544441d54172b1");
  });
});

describe("checkAuthorization", () => {
  const customId = holdCustomId("s", newId(), bytes32());
  const auth: PaymentAuthorization = {
    id: "0VF52814937998046",
    status: AuthorizationStatus.Created,
    amount: { currencyCode: "USD", value: "100.00" },
    customId,
    payee: { merchantId: STORE },
    createTime: "2026-11-08T10:00:00Z",
    expirationTime: "2026-12-07T10:00:00Z",
  };
  const expected = { customId, amount: hundred, payees: [STORE] };

  it("returns the id and the times of a matching authorization", () => {
    expect(checkAuthorization(auth, expected)).toEqual({
      authorizationId: "0VF52814937998046",
      createTime: new Date("2026-11-08T10:00:00Z"),
      expirationTime: new Date("2026-12-07T10:00:00Z"),
    });
  });

  it.each([
    ["status", { status: AuthorizationStatus.Voided }],
    ["custom_id", { customId: holdCustomId("s", newId(), bytes32()) }],
    ["amount", { amount: { currencyCode: "USD", value: "100.01" } }],
    ["currency", { amount: { currencyCode: "EUR", value: "100.00" } }],
    ["payee", { payee: { merchantId: "OTHERMERCHANT1" } }],
    ["payee", { payee: {} }],
    ["id", { id: "" }],
  ] as const)("refuses a different %s", (field, change) => {
    const thrown = (() => {
      try {
        checkAuthorization({ ...auth, ...change }, expected);
      } catch (e) {
        return e;
      }
    })();
    expect(thrown).toBeInstanceOf(HoldMismatchError);
    expect((thrown as HoldMismatchError).field).toBe(field);
  });
});

describe("isAuthorizationGone", () => {
  const error = (issue: string) =>
    new PayPalError(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue }] });

  it.each([
    "AUTHORIZATION_VOIDED",
    "AUTHORIZATION_EXPIRED",
    "PREVIOUSLY_VOIDED",
    "PREVIOUSLY_CAPTURED",
  ])("is true for %s", (issue) => {
    expect(isAuthorizationGone(error(issue))).toBe(true);
  });

  it("is false for other issues", () => {
    expect(isAuthorizationGone(error("REAUTHORIZATION_TOO_SOON"))).toBe(false);
  });
});
