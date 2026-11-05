import { DST, hashObject } from "./hash.ts";
import { type Money, toPayPalValue } from "./money.ts";

type Hex = `0x${string}`;

export interface AlibiFields {
  mandateHash: Hex;
  cartHash: Hex;
  policySetHash: Hex;
  countersignDigest: Hex;
  merchantId: string;
  amount: Money;
  paypalOrderId?: string;
}

/**
 * Computes `hashObject(DST.alibi, …)` over the snake_case Alibi fields. The amount is hashed in
 * PayPal's decimal format and the currency is taken from it, so each purchase has one digest.
 */
export function alibiDigest(fields: AlibiFields): Uint8Array {
  return hashObject(DST.alibi, {
    mandate_hash: fields.mandateHash,
    cart_hash: fields.cartHash,
    policy_set_hash: fields.policySetHash,
    countersign_digest: fields.countersignDigest,
    merchant_id: fields.merchantId,
    amount: toPayPalValue(fields.amount),
    currency: fields.amount.currency,
    ...(fields.paypalOrderId === undefined ? {} : { paypal_order_id: fields.paypalOrderId }),
  });
}
