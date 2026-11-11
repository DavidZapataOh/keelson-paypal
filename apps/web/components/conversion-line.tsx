import { type Conversion, describeConversion } from "@keelson/core";

const percent = (bps: number) =>
  new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 }).format(bps / 1e4);

/**
 * What the buyer paid when PayPal converted the charge to their currency, as the receipt states it
 * (`Paid 10.231 COP (USD 2.95 at 3.468,14)`), with PayPal's spread over the reference rate and the
 * cap the mandate set. The reference rates are ExchangeRate-API's, which asks for this attribution.
 */
export function ConversionLine({ conversion }: { conversion: Conversion }) {
  const asOf = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
    new Date(conversion.reference.as_of),
  );
  return (
    <div className="grid gap-1 text-sm">
      <p className="font-medium tabular-nums">{describeConversion(conversion)}</p>
      <p className="text-muted-foreground">
        PayPal's rate is {percent(conversion.spread_bps)} from the mid-market rate of{" "}
        <span className="tabular-nums">{conversion.reference.rate}</span> on {asOf}; the mandate
        allows {percent(conversion.max_spread_bps)}.{" "}
        <a
          href="https://www.exchangerate-api.com"
          target="_blank"
          rel="noopener"
          className="underline decoration-border underline-offset-4 hover:decoration-foreground"
        >
          Rates By Exchange Rate API
        </a>
      </p>
    </div>
  );
}
