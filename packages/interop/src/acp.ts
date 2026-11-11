/**
 * ACP 2026-04-17 Delegate Payment (github.com/agentic-commerce-protocol/agentic-commerce-protocol,
 * `spec/2026-04-17/json-schema/schema.delegate_payment.json`): the `allowance` and `metadata` of a
 * `DelegatePaymentRequest`. The card itself is the credential provider's to supply.
 */

/** ACP `Allowance`. */
export interface AcpAllowance {
  reason: "one_time";
  max_amount: number;
  currency: string;
  checkout_session_id: string;
  merchant_id: string;
  expires_at: string;
}

/** How long a delegated token may live past its issue, at most. */
export const ACP_MAX_TTL_SECONDS = 15 * 60;

/**
 * The allowance a Keelson mandate grants one checkout: no more than the per-purchase cap or the
 * budget left, in the mandate's currency in lower case, and valid until the mandate expires or
 * 15 minutes pass, whichever is first. `metadata.keelson_alibi` names the purchase's Alibi.
 */
export function acpDelegation(input: {
  currency: string;
  maxAmountMinor: number;
  remainingMinor: number;
  /** The mandate's `exp`, in seconds since the epoch. */
  exp: number;
  /** Seconds since the epoch. */
  now: number;
  checkoutSessionId: string;
  merchantId: string;
  alibiId?: string;
}): { allowance: AcpAllowance; metadata: Record<string, string> } {
  const expiresAt = Math.min(input.exp, input.now + ACP_MAX_TTL_SECONDS);
  return {
    allowance: {
      reason: "one_time",
      max_amount: Math.max(0, Math.min(input.maxAmountMinor, input.remainingMinor)),
      currency: input.currency.toLowerCase(),
      checkout_session_id: input.checkoutSessionId,
      merchant_id: input.merchantId,
      expires_at: new Date(expiresAt * 1000).toISOString().replace(".000Z", "Z"),
    },
    metadata: input.alibiId ? { keelson_alibi: input.alibiId } : {},
  };
}
