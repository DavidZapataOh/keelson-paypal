import { jcs, sha256, toHex } from "@keelson/core";

/**
 * What decided the amount a live checkout pays: PayPal's Orders API, the store's signature over
 * its cart, the user's passkey, or only PayPal's checkout page, which is never an authority.
 */
export type AmountAuthority =
  | "paypal_order"
  | "merchant_signed_cart"
  | "user_confirmed"
  | "checkout_page";

/** A live checkout's amount, and what decided it. */
export interface AmountCheck {
  v: "keelson.amount_check/1";
  authority: AmountAuthority;
  /** For `paypal_order`: read with Keelson's own credentials, or for a connected merchant. */
  via?: "own" | "partner" | "ucp";
  read_by: "api" | "tee:A";
  /** SHA-256 of the PayPal order id: the id itself stays out of public copies. */
  order_id_hash: `0x${string}`;
  total: { currency: string; minor: number };
  payee: string;
  intent: "CAPTURE" | "AUTHORIZE";
  /** RFC 3339, UTC. */
  checked_at: string;
  /** What PayPal's checkout stated for the same order; one that disagrees never passes. */
  cross_check: "agrees" | "unavailable";
  evidence?: {
    /** The user's WebAuthn assertion over {@link amountConfirmChallenge}, base64url fields. */
    assertion?: {
      credentialId: string;
      authenticatorData: string;
      clientDataJSON: string;
      signature: string;
    };
  };
}

const encoder = new TextEncoder();

/** SHA-256 of a PayPal order id, as an {@link AmountCheck} names the order. */
export function orderIdHash(orderId: string): `0x${string}` {
  return toHex(sha256(encoder.encode(orderId)));
}

/** What the user confirms with their passkey for a live checkout. */
export interface AmountConfirmation {
  purchase_id: string;
  order_id_hash: `0x${string}`;
  currency: string;
  minor: number;
  payee: string;
}

const CONFIRM_DST = "keelson/amount-confirm/v1";

/**
 * The WebAuthn challenge of an amount confirmation:
 * `SHA-256("keelson/amount-confirm/v1" || 0x00 || JCS(confirmation))`.
 */
export function amountConfirmChallenge(c: AmountConfirmation): Uint8Array {
  const prefix = encoder.encode(CONFIRM_DST);
  const body = encoder.encode(
    jcs({
      purchase_id: c.purchase_id,
      order_id_hash: c.order_id_hash,
      currency: c.currency,
      minor: c.minor,
      payee: c.payee,
    }),
  );
  const input = new Uint8Array(prefix.length + 1 + body.length);
  input.set(prefix, 0);
  input.set(body, prefix.length + 1);
  return sha256(input);
}
