import { DST, hashObject } from "./hash.ts";

/** One line of a proposed cart. */
export interface CartLine {
  sku: string;
  size?: string | null;
  color?: string | null;
  category: string;
  qty: number;
  unit_minor: number;
}

/** A proposed cart, as the engine reads it. */
export interface Cart {
  merchant: string;
  currency: string;
  lines: CartLine[];
  return_days: number;
  returns_free: boolean;
}

/**
 * `H("keelson/cart/v1", cart)` over the cart's own members, with an absent `size` or `color`
 * as `null`. The agent signs it as `cart_hash` in the closed mandate's key binding.
 */
export function cartHash(cart: Cart): Uint8Array {
  return hashObject(DST.cart, {
    merchant: cart.merchant,
    currency: cart.currency,
    lines: cart.lines.map((l) => ({
      sku: l.sku,
      size: l.size ?? null,
      color: l.color ?? null,
      category: l.category,
      qty: l.qty,
      unit_minor: l.unit_minor,
    })),
    return_days: cart.return_days,
    returns_free: cart.returns_free,
  });
}
