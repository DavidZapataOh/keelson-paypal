import { z } from "@hono/zod-openapi";
import { fromPayPalAmount } from "@keelson/core";
import { and, type Db, eq, evidenceItems, inArray } from "@keelson/db";

export const Breakdown = z
  .object({
    items: z.string(),
    tax: z.string(),
    shipping: z.string(),
    discount: z.string(),
  })
  .openapi("CheckoutBreakdown", {
    description:
      "What the countersigned total is made of, in minor units: the items, plus tax and shipping, less discounts. Absent for purchases countersigned without it.",
  });

export type Breakdown = z.infer<typeof Breakdown>;

/**
 * The breakdown of each purchase's checkout total, read from the `api.checkout` item its evidence
 * root binds, keyed by the root in hex. A root with no such item is left out.
 */
export async function breakdowns(
  db: Pick<Db, "select">,
  roots: readonly (Buffer | null)[],
): Promise<Map<string, Breakdown>> {
  const wanted = roots.filter((r): r is Buffer => r !== null);
  const out = new Map<string, Breakdown>();
  if (wanted.length === 0) return out;
  const rows = await db
    .select({ root: evidenceItems.root, bytes: evidenceItems.bytes })
    .from(evidenceItems)
    .where(and(inArray(evidenceItems.root, wanted), eq(evidenceItems.type, "api.checkout")));
  for (const r of rows) {
    if (!r.bytes) continue;
    try {
      const t = fromPayPalAmount(JSON.parse(Buffer.from(r.bytes).toString("utf8")));
      out.set(r.root.toString("hex"), {
        items: String(t.items),
        tax: String(t.tax),
        shipping: String(t.shipping),
        discount: String(t.discount),
      });
    } catch {
      // A purchase exists only once its countersign accepted the item as its PayPal amount.
    }
  }
  return out;
}

/** A purchase's `amount`: the countersigned total and, when its evidence holds it, its breakdown. */
export const Amount = z.object({
  currency: z.string(),
  minor: z.string(),
  breakdown: Breakdown.optional(),
});

/** The `amount` of a purchase view with its breakdown, when its evidence has one. */
export function withBreakdown<T extends { amount: { currency: string; minor: string } }>(
  view: T,
  root: Buffer | null,
  found: Map<string, Breakdown>,
): T {
  const b = root ? found.get(root.toString("hex")) : undefined;
  return b ? { ...view, amount: { ...view.amount, breakdown: b } } : view;
}
