import type * as React from "react";
import { cn } from "#lib/utils";

const formats = new Map<string, Intl.NumberFormat>();

function formatter(currency: string): Intl.NumberFormat {
  let f = formats.get(currency);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { style: "currency", currency });
    formats.set(currency, f);
  }
  return f;
}

/**
 * A money amount in Geist Mono with tabular figures: the cents set small and raised, the currency
 * code muted. `signed` shows `+` for credits; negatives use a true minus. `struck` crosses the
 * amount out (a blocked or failed payment) and gives the reason to assistive technology.
 */
function Amount({
  value,
  currency = "USD",
  signed = false,
  struck,
  hideCurrency = false,
  className,
  ...props
}: React.ComponentProps<"span"> & {
  value: number;
  currency?: string;
  signed?: boolean;
  struck?: string;
  hideCurrency?: boolean;
}) {
  const parts = formatter(currency).formatToParts(Math.abs(value));
  const sign = value < 0 ? "−" : signed && value > 0 ? "+" : "";
  const whole = parts
    .filter((p) => p.type !== "decimal" && p.type !== "fraction")
    .map((p) => p.value)
    .join("");
  const cents = parts.find((p) => p.type === "fraction")?.value;
  // Screen readers get the plain figure; the raised cents are visual only.
  const plain = `${sign}${formatter(currency).format(Math.abs(value))}`;
  const figure = (
    <span aria-hidden="true">
      {sign}
      {whole}
      {cents && <span className="align-[0.4em] text-[0.62em]">.{cents}</span>}
    </span>
  );
  return (
    <span
      data-slot="amount"
      className={cn("inline-flex items-baseline gap-1 font-mono tabular-nums", className)}
      {...props}
    >
      <span className="sr-only">
        {plain}
        {struck ? `, ${struck}` : ""}
      </span>
      {struck ? <s className="decoration-1">{figure}</s> : figure}
      {!hideCurrency && (
        <span aria-hidden="true" className="text-[0.75em] text-muted-foreground">
          {currency}
        </span>
      )}
    </span>
  );
}

export { Amount };
