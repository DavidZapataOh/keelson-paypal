/**
 * The terms a user accepts by signing a mandate. The mandate carries their hash in
 * `consent.terms_hash`, so the passkey signature covers exactly this text; the app shows it
 * before the user signs. Changing a word changes the hash, which a test pins.
 */
export const TERMS = `Keelson mandate terms, version 1.

1. You authorize the agent named in this mandate to buy for you only within what the card shows: the items, total, budget, stores, deadline and its other fields.
2. Keelson checks every cart against this mandate before payment. A cart outside it is blocked and not paid.
3. Each field shows who answers if the agent gets it wrong: Keelson for green fields; the agent's operator, from its bond and up to it, for amber fields; you for gray fields, which nobody covers.
4. When you approve on PayPal, PayPal authorizes your budget, or each cart for a mandate with several stores. Keelson captures only the amount of a cart it countersigned. What is not spent is released when the mandate ends or you revoke it.
5. Store return and refund policies still apply. PayPal decides disputes; Keelson brings the evidence and names the party at fault.
6. Keelson is not insurance. It does not judge taste or preference.`;

/** `sha256:` and the lowercase hex SHA-256 of the UTF-8 bytes of {@link TERMS}. */
export const TERMS_HASH = "sha256:0c71fd831591ac606aed8279a6940bbecd1d45f2c5ad0cc7df833399be3e7afe";
