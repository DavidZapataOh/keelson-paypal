/**
 * The terms a user accepts by signing a mandate. The mandate carries their hash in
 * `consent.terms_hash`, so the passkey signature covers exactly this text; the app shows it
 * before the user signs. Changing a word changes the hash, which a test pins.
 */
export const TERMS = `Keelson mandate terms, version 1.

1. You authorize the agent named in this mandate to buy on your behalf only within the limits shown: the items, total, budget, stores, deadline and the other fields of the card.
2. Keelson checks every cart against this mandate before payment. A cart outside it is not paid.
3. Each field shows who answers if the agent gets it wrong: Keelson for green fields, the agent's operator from its bond for amber fields, and you for gray fields. Gray fields are not covered.
4. PayPal holds the budget when you approve the hold and captures only the amount of each countersigned cart. What is left is released when the mandate ends or you revoke it.
5. Merchant return and refund policies apply at capture. PayPal still decides disputes.
6. Keelson is not insurance. It does not judge taste or preference.`;

/** `sha256:` and the lowercase hex SHA-256 of the UTF-8 bytes of {@link TERMS}. */
export const TERMS_HASH = "sha256:1f464c17f60af2fd0b8339ec4f344618d2ef3ed0faa456d5e1ffa29ef1f68bea";
