import { Amount } from "@keelson/ui/components/amount";
import { DataItem, DataList } from "@keelson/ui/components/data-list";
import { major } from "../lib/format";
import type { Amount as Money } from "../lib/types";

type Line = { label: string; minor: string; credit?: boolean };

/** The parts of a countersigned total, or none for a total that is the items alone. */
function lines(amount: Money): Line[] | undefined {
  const b = amount.breakdown;
  if (!b || (b.tax === "0" && b.shipping === "0" && b.discount === "0")) return undefined;
  return [
    { label: "Items", minor: b.items },
    ...(b.tax !== "0" ? [{ label: "Tax", minor: b.tax }] : []),
    ...(b.shipping !== "0" ? [{ label: "Shipping", minor: b.shipping }] : []),
    ...(b.discount !== "0" ? [{ label: "Discount", minor: b.discount, credit: true }] : []),
  ];
}

/**
 * What a countersigned total is made of, when the checkout added tax, shipping or a discount to
 * the items. `ledger` lists each part over the total, for a receipt; `inline` sets them on one
 * line, for a list row. Nothing for a total that is the items alone.
 */
export function CheckoutBreakdown({
  amount,
  layout = "inline",
}: {
  amount: Money;
  layout?: "ledger" | "inline";
}) {
  const parts = lines(amount);
  if (!parts) return null;
  const figure = (l: Line) => (
    <Amount
      value={major(l.minor, amount.currency) * (l.credit ? -1 : 1)}
      currency={amount.currency}
      hideCurrency
    />
  );

  if (layout === "inline")
    return (
      <ul
        aria-label="Checkout total"
        className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm"
      >
        {parts.map((l) => (
          <li key={l.label} className="inline-flex items-baseline gap-1.5">
            <span className="text-muted-foreground">{l.label}</span>
            {figure(l)}
          </li>
        ))}
      </ul>
    );

  return (
    <section aria-label="Checkout total" className="rounded-3xl border bg-card px-5 py-3 sm:px-6">
      <DataList>
        {parts.map((l) => (
          <DataItem key={l.label} label={l.label}>
            {figure(l)}
          </DataItem>
        ))}
        <DataItem
          label={<span className="font-medium text-foreground">Total</span>}
          className="text-base"
        >
          <Amount
            value={major(amount.minor, amount.currency)}
            currency={amount.currency}
            className="font-medium"
          />
        </DataItem>
      </DataList>
    </section>
  );
}
