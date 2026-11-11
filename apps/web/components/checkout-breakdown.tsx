import { money } from "../lib/format";
import type { Amount } from "../lib/types";

/**
 * What a countersigned total is made of, when the checkout added tax, shipping or a discount to
 * the items. Nothing for a total that is the items alone.
 */
export function CheckoutBreakdown({ amount }: { amount: Amount }) {
  const b = amount.breakdown;
  if (!b || (b.tax === "0" && b.shipping === "0" && b.discount === "0")) return null;
  const m = (minor: string) => money(minor, amount.currency);
  const parts = [
    `Items ${m(b.items)}`,
    ...(b.tax !== "0" ? [`tax ${m(b.tax)}`] : []),
    ...(b.shipping !== "0" ? [`shipping ${m(b.shipping)}`] : []),
  ].join(" + ");
  return (
    <p className="text-muted-foreground text-sm tabular-nums">
      {parts}
      {b.discount !== "0" ? ` − discount ${m(b.discount)}` : ""}
    </p>
  );
}
