import type { Cart } from "@keelson/core";
import type { Context, Variant } from "./evaluate.ts";

/**
 * The Cedar context of a cart, as the engine's canonicalizer derives it: the total, the merchant,
 * the categories, and each variant with its quantity summed across lines.
 */
export function cartContext(cart: Cart): Context {
  const qty = new Map<string, [Variant, number]>();
  let total = 0;
  let maxUnit = 0;
  for (const l of cart.lines) {
    total += l.qty * l.unit_minor;
    maxUnit = Math.max(maxUnit, l.unit_minor);
    const v: Variant = {
      sku: l.sku,
      ...(l.size != null && { size: l.size }),
      ...(l.color != null && { color: l.color }),
    };
    const key = JSON.stringify([v.sku, v.size ?? null, v.color ?? null]);
    const seen = qty.get(key);
    qty.set(key, [v, (seen?.[1] ?? 0) + l.qty]);
  }
  const quantities = [...qty.values()];
  return {
    currency: cart.currency,
    total_minor: total,
    merchant: cart.merchant,
    categories: [...new Set(cart.lines.map((l) => l.category))],
    variants: quantities.map(([v]) => v),
    max_line_qty: Math.max(0, ...quantities.map(([, n]) => n)),
    max_unit_minor: maxUnit,
    return_days: cart.return_days,
    returns_free: cart.returns_free,
    quantities,
  };
}
