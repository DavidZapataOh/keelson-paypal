import type { Purchase } from "./types";

/** The store a card purchase was paid at, as the card network named it. */
export function cardStore(p: Purchase): string {
  const a = p.card?.authorizations.find((x) => x.approved) ?? p.card?.authorizations[0];
  return a?.merchantName ?? (p.merchantId === "*" ? "Any store" : p.merchantId);
}
