import type { FxReference } from "@keelson/core";

/**
 * Synthetic PayPal review pages for a buyer whose PayPal converts a USD order to their own
 * currency, shaped like PayPal's: the order line in USD, the rate line, and the converted total.
 * Every rate is made up and every name, address and number is a test buyer's.
 */
export interface Buyer {
  currency: string;
  locale: string;
  /** COP per USD, as PayPal shows it. */
  rate: string;
  /** The decimals PayPal shows the converted amount with. */
  shown: number;
  /** How the page labels the converted total. */
  pay: string;
}

export const BUYERS: readonly Buyer[] = [
  { currency: "COP", locale: "es-CO", rate: "3468.14", shown: 0, pay: "Pagarás" },
  { currency: "BRL", locale: "pt-BR", rate: "5.8231", shown: 2, pay: "Você paga" },
  { currency: "JPY", locale: "ja-JP", rate: "162.47", shown: 0, pay: "合計" },
  { currency: "EUR", locale: "de-DE", rate: "0.9312", shown: 2, pay: "Gesamtbetrag" },
  { currency: "MXN", locale: "es-MX", rate: "19.4127", shown: 2, pay: "Pagarás" },
  { currency: "KWD", locale: "ar-KW", rate: "0.3189", shown: 3, pay: "الإجمالي" },
  { currency: "INR", locale: "hi-IN", rate: "88.6214", shown: 2, pay: "Total" },
  { currency: "GBP", locale: "en-GB", rate: "0.7931", shown: 2, pay: "You'll pay" },
];

/** A reference rate PayPal's is 5% over, about the spread PayPal charges in many markets. */
export const reference = (o: Partial<FxReference> = {}): FxReference => ({
  v: "keelson.fx_reference/1",
  provider: "ExchangeRate-API",
  source: "https://open.er-api.com/v6/latest/USD",
  base: "USD",
  as_of: new Date(Date.now() - 3600_000).toISOString(),
  fetched_at: new Date().toISOString(),
  rates: Object.fromEntries(
    BUYERS.map((b) => [b.currency, (Number(b.rate) / 1.05).toPrecision(8)]),
  ),
  ...o,
});

/** `usd` cents converted at `rate`, rounded half up to `shown` decimals, as a decimal string. */
export function convert(usd: number, rate: string, shown: number): string {
  const [w = "", f = ""] = rate.split(".");
  const exact = BigInt(usd) * BigInt(`${w}${f}`);
  const from = 2 + f.length;
  const scale = 10n ** BigInt(from - shown);
  const q = (exact * 2n + scale) / (2n * scale);
  const t = q.toString().padStart(shown + 1, "0");
  return shown ? `${t.slice(0, -shown)}.${t.slice(-shown)}` : t;
}

const number = (value: string, locale: string) => {
  const digits = value.split(".")[1]?.length ?? 0;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(value));
};

/** How PayPal writes an amount: its narrow sign, the number in the page's locale, its ISO code. */
export function money(value: string, currency: string, locale: string): string {
  const sign =
    new Intl.NumberFormat("en", { style: "currency", currency, currencyDisplay: "narrowSymbol" })
      .formatToParts(1)
      .find((p) => p.type === "currency")?.value ?? "";
  return `${sign === currency ? "" : sign}${number(value, locale)} ${currency}`;
}

/** The text of a review page, one row per line. */
export function reviewText(o: {
  buyer: Buyer;
  usd: number;
  locale?: string;
  /** The converted total shown; `convert` of the order by default. */
  pays?: string;
  rate?: string | null;
  extra?: string[];
}): string[] {
  const locale = o.locale ?? o.buyer.locale;
  const english = locale.startsWith("en");
  const usd = `$${(o.usd / 100).toFixed(2)} USD`;
  const pays = o.pays ?? convert(o.usd, o.buyer.rate, o.buyer.shown);
  const rate = o.rate === undefined ? o.buyer.rate : o.rate;
  return [
    `The Change ${usd}`,
    ...(rate === null ? [] : [`1 USD = ${number(rate, locale)} ${o.buyer.currency}`]),
    `${english ? "You'll pay" : o.buyer.pay} ${money(pays, o.buyer.currency, locale)}`,
    ...(o.extra ?? []),
  ];
}

/** A review page as HTML, its rows as the page lays them out, with a pay button. */
export function reviewPage(lines: readonly string[], lang: string, script = ""): string {
  const rows = lines.map((l) => `<div>${l}</div>`).join("\n");
  return `<!doctype html><html lang="${lang}"><body><h1>PayPal</h1>
<section aria-label="Pagar con"><p>Ana Prueba · ana.prueba@example.test</p>${rows}</section>
<button>Pay Now</button><p id="out"></p>
<script>for (const b of document.querySelectorAll("button")) b.onclick = () => { document.getElementById("out").textContent = "clicked " + b.textContent; };${script}</script>
</body></html>`;
}

/** A sanitized `GetCheckoutDetails` answer for an order. */
export function checkoutDetails(o: {
  value: string;
  currency?: string;
  intent?: string;
  payee?: string;
  parts?: { subtotal: string; shipping: string; tax: string };
}) {
  const currency = o.currency ?? "USD";
  const amount = (currencyValue: string) => ({ currencyValue, currencyCode: currency });
  const parts = o.parts ?? { subtotal: "0.00", shipping: "0.00", tax: "0.00" };
  return {
    data: {
      checkoutSession: {
        cart: {
          intent: o.intent ?? "SALE",
          amounts: {
            subtotal: amount(parts.subtotal),
            shippingAndHandling: amount(parts.shipping),
            tax: amount(parts.tax),
            total: amount(o.value),
          },
        },
        payees: [{ merchantId: o.payee ?? "SANDBOXPAYEE01" }],
      },
    },
  };
}

/** The review page's own answer about the buyer's funding options, with PayPal's conversion. */
export function fundingOptions(o: { from: string; to: string; currency: string; rate: string }) {
  return {
    data: {
      checkoutSession: {
        fundingOptions: [
          {
            id: "balance",
            currencyConversion: {
              rate: o.rate,
              type: "PAYPAL",
              from: { currencyValue: o.from, currencyCode: "USD" },
              to: { currencyValue: o.to, currencyCode: o.currency },
            },
          },
        ],
      },
    },
  };
}
