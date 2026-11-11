# PayPal Agent Mandate Extension

**Status:** open convention, version 1. Anyone may implement it. Keelson implements it in
[`@keelson/paypal`](../packages/paypal/src/ids.ts) and verifies it in
[`@keelson/alibi`](../packages/alibi/src/verify/checks/paypal.ts).

When an AI agent pays through PayPal, the payment carries no sign of who authorized it or under
what limits. When the buyer later disputes it, the dispute carries no sign of it either. This
extension uses fields PayPal already has to tie each order, capture, refund and payout to the
mandate the user signed and to a public record of the purchase. It needs no change on PayPal's
side.

## Fields used

| PayPal object                         | Field                      | Limit                               | What it carries                                                                       |
| ------------------------------------- | -------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| Order (Orders v2), `purchase_units[]` | `custom_id`                | 127 characters                      | `ks-custom`: the mandate or purchase and a digest binding it                          |
| Order, `purchase_units[]`             | `reference_id`             |                                     | The mandate id, or the purchase's request id                                          |
| Order, `purchase_units[]`             | `description`              | 127 characters                      | A human-readable line naming the mandate, and for a single purchase the verifier link |
| Capture (Payments v2)                 | `invoice_id`               | 127 characters, unique per merchant | `ks-invoice`: the purchase, its sequence on the hold and a digest                     |
| Refund (Payments v2)                  | `custom_id`                |                                     | `ks-verdict`: the verdict that ordered it                                             |
| Payout item (Payouts v1)              | `sender_item_id`           | 63 characters                       | `ks-verdict`                                                                          |
| Every create call                     | `PayPal-Request-Id` header |                                     | Derived from the signed object, so a retry is the same operation                      |

A capture has no `custom_id`, which is why each purchase is named by its capture's `invoice_id`.
PayPal's Disputes API returns the order's `custom_id` and the capture's `invoice_id` with the
disputed transaction (`disputed_transactions[].custom` and `invoice_number`), so the dispute
leads back to the purchase.

## Grammar

```abnf
; purchase_units[].custom_id
ks-custom  = "ks1" "." env kind "." ulid "." digest       ; 77 characters
env        = "s" / "p"                                   ; sandbox / production
kind       = "m" / "a"                                   ; m: a mandate's hold, a: one purchase's hold
ulid       = 26CROCKFORD                                 ; first character 0-7
digest     = 43B64URL                                    ; 32 bytes, unpadded base64url

; captures: invoice_id
ks-invoice = "KS1-" ulid "-" 2DIGIT "-" 26CROCKFORD       ; 60 characters

; refunds: custom_id; payouts: sender_item_id
ks-verdict = "ksv1." ulid "." 16B64URL                    ; 48 characters

CROCKFORD  = DIGIT / %x41-48 / %x4A-4B / %x4D-4E / %x50-54 / %x56-5A   ; 0-9 A-Z without I L O U
B64URL     = ALPHA / DIGIT / "-" / "_"
```

Encodings are canonical: base64url without padding and with zero trailing bits, Crockford base32
in upper case. A parser rejects any other spelling, so each digest has exactly one.

`invoice_id` is visible to the payer, so every form holds only ids and hashes, never personal
data.

## Digests

All digests use the domain-separated hash `H(dst, v) = SHA-256(utf8(dst) ‖ 0x00 ‖ utf8(JCS(v)))`,
with JCS from RFC 8785. Amounts are PayPal's decimal string and currency code.

| Form          | `ulid`                    | Digest                                                                                                                                                        |
| ------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ks1.<env>m.` | The mandate id (`mid`)    | The mandate hash `M = SHA-256("keelson/mandate-challenge/v1" ‖ 0x00 ‖ H_sd ‖ C_m)`, the challenge the user's passkey signed                                   |
| `ks1.<env>a.` | The purchase's request id | `H("keelson/alibi/v1", {mandate_hash, cart_hash, merchant_id, amount, currency})`                                                                             |
| `KS1-`        | The purchase id           | The first 16 bytes of `H("keelson/alibi/v1", {mandate_hash, cart_hash, policy_set_hash, countersign_digest, merchant_id, amount, currency, paypal_order_id})` |
| `ksv1.`       | The verdict id            | The first 12 bytes of the verdict's EIP-712 digest                                                                                                            |

The two-digit sequence in `KS1-` counts the captures taken from one hold, from `01` to `99`.

`PayPal-Request-Id` is the first 36 hex characters of a digest: the countersign digest for a
capture, the verdict digest for a refund or payout, `M` for a mandate's hold, and
`SHA-256(custom_id)` for a single purchase's hold.

## Verifying a payment

Given a PayPal order, capture or dispute:

1. Parse `custom_id` and `invoice_id` with the grammar. Anything else is not under this extension.
2. Fetch the public record of the purchase named by a `ks1.<env>a.` or `KS1-` id. Keelson serves
   it at `https://verify.keelson.finance/a/<ulid>`, and the record's leaf is in the public log at
   `log.keelson.finance`. A `ks1.<env>m.` id names the mandate's hold, which covers every purchase
   captured from it.
3. Recompute the digest from the record's fields and compare. A match binds the PayPal object to
   the mandate the user signed and to the cart the TEEs countersigned.

`/paypal/capture_id` is the one value no signature covers, because PayPal assigns it after the
countersign. Verifiers show it as unverified metadata.

## Example

Well-formed values (the digests are illustrative):

```
custom_id   ks1.sm.01K9QKRARY9ND8RYVAB543E9GN.DLNvjrqd4CbuAjJNwxF1mR_-DYrfBixgPElCYxIRDlA
invoice_id  KS1-01K9QKT2GV5GYMWQV0E619795N-01-4J5FTZDF5FEVKHV98PVWGZ66MS
```

## Proposal for PayPal's Agent Toolkit

PayPal's [Agent Toolkit](https://github.com/paypal/agent-toolkit) `create_order` tool does not let
an agent set `intent` or `custom_id`, so an agent using it can neither place a hold nor tag an
order. Adding both, with the limits of the Orders v2 API, is enough for any agent to follow this
extension.

> TODO: link the Agent Toolkit pull request and its issue comments once they are published.
