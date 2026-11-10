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
 * A money amount in Geist Mono with tabular figures, its currency code muted. `signed` shows `+`
 * for credits; negatives use a true minus. `struck` crosses the amount out (a blocked or failed
 * payment) and gives the reason to assistive technology.
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
  const text = formatter(currency).format(Math.abs(value));
  const sign = value < 0 ? "−" : signed && value > 0 ? "+" : "";
  const figure = `${sign}${text}`;
  return (
    <span
      data-slot="amount"
      className={cn("inline-flex items-baseline gap-1 font-mono tabular-nums", className)}
      {...props}
    >
      {struck ? (
        <>
          <s className="decoration-1">{figure}</s>
          <span className="sr-only">{struck}</span>
        </>
      ) : (
        <span>{figure}</span>
      )}
      {!hideCurrency && <span className="text-[0.75em] text-muted-foreground">{currency}</span>}
    </span>
  );
}

export { Amount };
