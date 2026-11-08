import {
  type CurrencyCode,
  DST,
  fromPayPalValue,
  hashObject,
  type Money,
  sha256,
  toHex,
  toPayPalValue,
} from "@keelson/core";
import {
  AuthorizationStatus,
  CheckoutPaymentIntent,
  type OrderRequest,
  type PaymentAuthorization,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
} from "@paypal/paypal-server-sdk";
import type { PayPalError } from "./errors.ts";
import { type Env, encodeCustomId, requestIdFromDigest } from "./ids.ts";

/** `custom_id` of a mandate hold: `ks1.<env>m.<mid>.<b64url(M)>`, where `M` is the signed mandate hash. */
export function holdCustomId(env: Env, mid: string, mandateHash: Uint8Array): string {
  return encodeCustomId({ env, kind: "m", id: mid, digest: mandateHash });
}

/** `custom_id` of a per-purchase hold: `ks1.<env>a.<request_id>.<b64url(digest)>`. */
export function purchaseHoldCustomId(env: Env, requestId: string, digest: Uint8Array): string {
  return encodeCustomId({ env, kind: "a", id: requestId, digest });
}

export interface PurchaseHoldFields {
  mandateHash: Uint8Array;
  cartHash: Uint8Array;
  merchantId: string;
  amount: Money;
}

/** Binds a per-purchase hold to the mandate, the cart, the merchant and the amount. */
export function purchaseHoldDigest({
  mandateHash,
  cartHash,
  merchantId,
  amount,
}: PurchaseHoldFields): Uint8Array {
  return hashObject(DST.alibi, {
    mandate_hash: toHex(mandateHash),
    cart_hash: toHex(cartHash),
    merchant_id: merchantId,
    amount: toPayPalValue(amount),
    currency: amount.currency,
  });
}

/** A Create Order call: its `PayPal-Request-Id` and body. */
export interface HoldOrder {
  paypalRequestId: string;
  body: OrderRequest;
}

export interface HoldOrderParams {
  env: Env;
  mid: string;
  mandateHash: Uint8Array;
  amount: Money;
  returnUrl: string;
  cancelUrl: string;
}

export interface PurchaseHoldOrderParams {
  env: Env;
  requestId: string;
  digest: Uint8Array;
  amount: Money;
  mid: string;
  merchantName: string;
  returnUrl: string;
  cancelUrl: string;
}

function authorizeOrder(
  unit: { referenceId: string; customId: string; description: string; amount: Money },
  experience: { returnUrl: string; cancelUrl: string; brandName?: string },
): OrderRequest {
  return {
    intent: CheckoutPaymentIntent.Authorize,
    purchaseUnits: [
      {
        referenceId: unit.referenceId,
        customId: unit.customId,
        description: unit.description,
        amount: { currencyCode: unit.amount.currency, value: toPayPalValue(unit.amount) },
      },
    ],
    paymentSource: {
      paypal: {
        experienceContext: {
          ...(experience.brandName === undefined ? {} : { brandName: experience.brandName }),
          userAction: PaypalExperienceUserAction.PayNow,
          shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
          returnUrl: experience.returnUrl,
          cancelUrl: experience.cancelUrl,
          locale: "en-US",
        },
      },
    },
  };
}

/** The `AUTHORIZE` order that holds a mandate's budget; retries reuse the request id `hex(M)[:36]`. */
export function holdOrderRequest({
  env,
  mid,
  mandateHash,
  amount,
  returnUrl,
  cancelUrl,
}: HoldOrderParams): HoldOrder {
  return {
    paypalRequestId: requestIdFromDigest(mandateHash),
    body: authorizeOrder(
      {
        referenceId: mid,
        customId: holdCustomId(env, mid, mandateHash),
        description: `Agent purchases under Keelson mandate ${mid}`,
        amount,
      },
      { returnUrl, cancelUrl },
    ),
  };
}

/**
 * The `AUTHORIZE` order for exactly one cart, keyed by the request id it is countersigned under.
 * Its `PayPal-Request-Id` derives from the whole `custom_id`, so the same cart under two request
 * ids is two orders while a retry of one request is the same order.
 */
export function purchaseHoldOrderRequest({
  env,
  requestId,
  digest,
  amount,
  mid,
  merchantName,
  returnUrl,
  cancelUrl,
}: PurchaseHoldOrderParams): HoldOrder {
  const customId = purchaseHoldCustomId(env, requestId, digest);
  return {
    paypalRequestId: requestIdFromDigest(sha256(new TextEncoder().encode(customId))),
    body: authorizeOrder(
      {
        referenceId: requestId,
        customId,
        description: `Agent purchase under Keelson mandate ${mid}; verify: verify.keelson.finance/a/${requestId}`,
        amount,
      },
      { returnUrl, cancelUrl, brandName: merchantName },
    ),
  };
}

export type HoldField = "id" | "status" | "custom_id" | "currency" | "amount" | "payee" | "time";

/** The authorization PayPal returned is not the hold Keelson asked for. */
export class HoldMismatchError extends Error {
  readonly field: HoldField;

  constructor(field: HoldField) {
    super(`authorization ${field} does not match the hold`);
    this.name = "HoldMismatchError";
    this.field = field;
  }
}

export interface ExpectedHold {
  customId: string;
  amount: Money;
  payees: readonly string[];
}

export interface CheckedAuthorization {
  authorizationId: string;
  createTime: Date;
  expirationTime: Date;
}

function minor(currency: CurrencyCode, value: string): bigint | undefined {
  try {
    return fromPayPalValue(currency, value).minor;
  } catch {
    return undefined;
  }
}

function time(value: string | undefined): Date {
  const date = new Date(value ?? Number.NaN);
  if (Number.isNaN(date.getTime())) throw new HoldMismatchError("time");
  return date;
}

/**
 * Checks a Show Authorized Payment (or Reauthorize) response against the hold: a `CREATED`
 * authorization of exactly the amount, under the `custom_id`, payable to one of `payees`.
 */
export function checkAuthorization(
  auth: PaymentAuthorization,
  expect: ExpectedHold,
): CheckedAuthorization {
  if (!auth.id) throw new HoldMismatchError("id");
  if (auth.status !== AuthorizationStatus.Created) throw new HoldMismatchError("status");
  if (auth.customId !== expect.customId) throw new HoldMismatchError("custom_id");
  if (auth.amount?.currencyCode !== expect.amount.currency) throw new HoldMismatchError("currency");
  if (minor(expect.amount.currency, auth.amount.value) !== expect.amount.minor) {
    throw new HoldMismatchError("amount");
  }
  const payee = auth.payee?.merchantId;
  if (payee === undefined || !expect.payees.includes(payee)) throw new HoldMismatchError("payee");
  return {
    authorizationId: auth.id,
    createTime: time(auth.createTime),
    expirationTime: time(auth.expirationTime),
  };
}

const GONE = new Set([
  "AUTHORIZATION_VOIDED",
  "AUTHORIZATION_EXPIRED",
  "PREVIOUSLY_VOIDED",
  "PREVIOUSLY_CAPTURED",
]);

/** True when PayPal refused because the authorization is already voided, expired or captured. */
export function isAuthorizationGone(err: PayPalError): boolean {
  return err.details.some((d) => GONE.has(d.issue));
}
