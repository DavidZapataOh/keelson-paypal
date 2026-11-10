import type { Card } from "@keelson/mandate/browser";
import { Liability, LiabilityField, type LiabilityKind } from "@keelson/ui/components/liability";

const KIND: Record<Card["rows"][number]["color"], LiabilityKind> = {
  green: "verified",
  amber: "attested",
  gray: "yours",
};

/** The mandate as the user signs it: each field, its value and who answers for it. */
export function MandateCard({ card }: { card: Card }) {
  return (
    <div className="grid gap-4">
      <div className="divide-y rounded-lg border bg-card px-5">
        {card.rows.map((row) => (
          <LiabilityField
            key={row.field}
            name={row.label}
            value={<span className="[overflow-wrap:anywhere]">{row.values.join(", ")}</span>}
            kind={KIND[row.color]}
          />
        ))}
      </div>
      {card.warnings.length > 0 ? (
        <ul className="grid gap-1.5 text-muted-foreground text-sm">
          {card.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** What the three liability colors mean, said once before the user signs. */
export function LiabilityLegend() {
  return (
    <ul className="grid gap-2 text-sm sm:grid-cols-3">
      <li className="grid gap-1">
        <Liability kind="verified" />
        <span className="text-muted-foreground">Keelson checks it and pays if it's wrong.</span>
      </li>
      <li className="grid gap-1">
        <Liability kind="attested" />
        <span className="text-muted-foreground">The agent's operator answers from its bond.</span>
      </li>
      <li className="grid gap-1">
        <Liability kind="yours" />
        <span className="text-muted-foreground">Your call. Nobody covers taste.</span>
      </li>
    </ul>
  );
}
