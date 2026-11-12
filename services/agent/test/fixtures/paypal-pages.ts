import { readFileSync } from "node:fs";
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
export function reviewPage(lines: readonly string[], lang: string): string {
  const rows = lines.map((l) => `<div>${l}</div>`).join("\n");
  return `<!doctype html><html lang="${lang}"><body><h1>PayPal</h1>
<section aria-label="Pagar con"><p>Ana Prueba · ana.prueba@example.test</p>${rows}</section>
<button>Pay Now</button><p id="out"></p>
<script>for (const b of document.querySelectorAll("button")) b.onclick = () => { document.getElementById("out").textContent = "clicked " + b.textContent; };</script>
</body></html>`;
}

/** A sanitized `GetCheckoutDetails` answer for an order. */
export function checkoutDetails(o: {
  value: string;
  currency?: string;
  intent?: string;
  payee?: string;
  parts?: {
    subtotal: string;
    shipping: string;
    tax: string;
    insurance?: string;
    smartDuty?: string;
    discount?: string;
  };
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
            insurance: parts.insurance ? amount(parts.insurance) : null,
            smartDuty: parts.smartDuty ? amount(parts.smartDuty) : null,
            discount: parts.discount ? amount(parts.discount) : null,
            total: amount(o.value),
          },
        },
        payees: [{ merchantId: o.payee ?? "SANDBOXPAYEE01" }],
      },
    },
  };
}

/**
 * A signed-in Colombian buyer's review page for a USD 2.95 order, in Spanish, as PayPal lays it
 * out when the buyer pays with a card: the card's last digits right before the converted amount,
 * the amount in pesos under the sign COP shares with USD, and PayPal's rate written from the
 * buyer's currency, `1 COP = 0,00029 USD`. The order line in USD is not shown.
 */
export const ES_CO_CARD_REVIEW: readonly string[] = [
  "Pagar con",
  "Visa Cargo ▪ ••4821 $ 10.236 COP",
  "$ 10.236",
  "Tipo de cambio de PayPal: 1 COP = 0,00029 USD",
  "Si continúas, autorizas a PayPal a cobrar el importe de $ 10.236 en tu tarjeta.",
];

/** A recorded fixture of PayPal's sandbox, in `fixtures/paypal`. */
export const recorded = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./paypal/${name}.json`, import.meta.url), "utf8"));

/**
 * A signed-in sandbox buyer's `xoos.getFundingSelection` answer for a EUR 2.95 order, recorded on
 * PayPal's `/pay` checkout: a bank account and a Visa card that PayPal converts to USD 3.40 at
 * `1 USD = 0.866445367 EUR`, the card with the issuer's conversion too, and a balance PayPal
 * disallows. Identifiers, digits and labels are replaced.
 */
export const RECORDED_SELECTION = "funding-selection-eur";

type Instrument = Record<string, unknown> & { id: string };

/** The recorded answer with its funding instruments replaced. */
export function fundingSelection(instruments: Instrument[]) {
  const answer = structuredClone(recorded(RECORDED_SELECTION)) as [
    { result: { data: { json: { fundingInstruments: Instrument[] } } } },
  ];
  answer[0].result.data.json.fundingInstruments = instruments;
  return answer;
}

/** The recorded instruments, by type: `BANK`, `CARD` and `BALANCE`. */
export function recordedInstrument(type: "BANK" | "CARD" | "BALANCE"): Instrument {
  const [answer] = recorded(RECORDED_SELECTION) as [
    { result: { data: { json: { fundingInstruments: Instrument[] } } } },
  ];
  return structuredClone(
    answer.result.data.json.fundingInstruments.find((i) => i.type === type) as Instrument,
  );
}

/** A card PayPal converts a USD order to the buyer's currency on, shaped like the recorded one. */
export function convertingCard(o: {
  id?: string;
  buyer: string;
  value: string;
  /** PayPal's rate from 1 unit of the buyer's currency to USD. */
  rate: string;
  vendor?: boolean;
}): Instrument {
  const card = recordedInstrument("CARD");
  return {
    ...card,
    id: o.id ?? (card.id as string),
    currencyConversionOptions: [
      {
        __typename: "CurrencyConversionPayPal",
        combinedFundingAmounts: [],
        conversionRateDurationWarning: false,
        type: "PAYPAL",
        conversionRate: {
          fromAmount: "1",
          fromCurrency: o.buyer,
          toAmount: o.rate,
          toCurrency: "USD",
        },
        convertedAmount: { currencyCode: o.buyer, value: o.value },
      },
      ...(o.vendor === false
        ? []
        : [{ __typename: "CurrencyConversionVendor", combinedFundingAmounts: [], type: "VENDOR" }]),
    ],
  };
}

/** The Pay form's fields as recorded, with `o` in place of the named ones. */
export function payForm(
  name: "pay-form-eur" | "pay-form-eur-card",
  o: Record<string, string | null> = {},
): [string, string][] {
  const fields = (recorded(name) as [string, string][]).filter(([k]) => o[k] !== null);
  const set = new Map(fields);
  for (const [k, v] of Object.entries(o)) if (v !== null) set.set(k, v);
  return [...set.entries()];
}

/** The Pay form of a USD 2.95 order the buyer pays with a card PayPal converts to `buyer`. */
export const cardForm = (buyer: string, value: string, o: Record<string, string | null> = {}) =>
  payForm("pay-form-eur-card", {
    purchaseCurrencyCode: "USD",
    purchaseAmount: "2.95",
    fundingInstrumentAmount: "2.95",
    selectedCurrencyConversionOptionCode: buyer,
    selectedRadioFiConvertedAmount: value,
    ...o,
  });

/**
 * PayPal's `/pay` review page: the rows, and the Pay form with its hidden fields, whose submit
 * PayPal's client handles. `script` runs on the page.
 */
export function payPage(
  lines: readonly string[],
  lang: string,
  fields: readonly [string, string][],
  o: { button?: string; script?: string; after?: string } = {},
): string {
  const rows = lines.map((l) => `<div>${l}</div>`).join("\n");
  const inputs = fields
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${v.replaceAll('"', "&quot;")}">`)
    .join("");
  return `<!doctype html><html lang="${lang}"><body><h1>PayPal</h1>
<form id="pay">${inputs}<section aria-label="Pagar con">${rows}</section>
<button type="submit"${o.button ?? ""}>Pay</button></form><p id="out"></p>${o.after ?? ""}
<script>document.getElementById("pay").onsubmit = (e) => { e.preventDefault(); document.getElementById("out").textContent = "clicked Pay"; };${o.script ?? ""}</script>
</body></html>`;
}

/** The selected plan of PayPal's hosted checkout, as its `GetFundingOptions` answers it. */
export function plans(
  o: {
    /** What the selected plan's funding source pays. */
    amount?: { currencyCode: string; currencyValue: string };
    conversion?: {
      type?: string;
      buyer: { currencyCode: string; currencyValue: string };
      /** PayPal's rate from 1 unit of the order's currency. */
      rate: string;
    };
    /** Other plans the buyer may switch to, not selected. */
    others?: Record<string, unknown>[];
    sources?: number;
  } = {},
) {
  const amount = o.amount ?? o.conversion?.buyer ?? { currencyCode: "USD", currencyValue: "2.95" };
  const source = {
    fundingInstrument: { id: "CC-SANDBOXCARD0001", type: "CARD", lastDigits: "4242" },
    amount,
  };
  return {
    data: {
      checkoutSession: {
        fundingOptions: [
          {
            allPlans: [
              {
                isSelected: true,
                fundingSources: Array.from({ length: o.sources ?? 1 }, () => source),
                currencyConversion: o.conversion
                  ? {
                      type: o.conversion.type ?? "PAYPAL",
                      from: { currencyCode: "USD", currencyValue: "1" },
                      to: {
                        currencyCode: o.conversion.buyer.currencyCode,
                        currencyValue: o.conversion.rate,
                      },
                      convertedAmount: o.conversion.buyer,
                    }
                  : null,
              },
              ...(o.others ?? []),
            ],
          },
        ],
      },
    },
  };
}

/**
 * The recorded `/pay` review page's text for that EUR order, one row per line, with the buyer's
 * name and address replaced.
 */
export const RECORDED_PAGE: readonly string[] = [
  "Select to view your profile. User initials",
  "JD",
  "Pay in full",
  "€2.95 today",
  "PayPal Credit",
  "Pay over time with a reusable credit line.",
  "Terms",
  "See PayPal Credit terms",
  "Pay with",
  "Your choice will be your preferred for future online purchases.",
  "Sandbox Bank",
  "Checking",
  "Last four digits 0001",
  "••0001",
  "$3.40",
  "USD",
  "Visa",
  "Credit",
  "Last four digits 4242",
  "••4242",
  "Show all payment methods",
  "Add card",
  "Add card",
  "Ship to",
  "Ana Prueba",
  "Calle 1 # 2-3, Bogotá",
  "Order",
  "$3.40",
  "PayPal rate: 1 USD = 0.86645 EUR",
  "About payment methods",
  "Pay",
  "Return to Test Store",
];

/**
 * A Colombian buyer's `/pay` review page for a USD 2.95 order paid with a card PayPal converts to
 * COP, row by row as the gate logged it: the card with its last digits and the converted amount
 * coded COP, the amount again under the sign COP shares with USD, PayPal's rate written from the
 * buyer's currency (twice), and the footer that names the amount once more.
 */
export const ES_CO_CARD_PAGE: readonly string[] = [
  "Pagar con",
  "Visa Cargo",
  "Últimos cuatro dígitos 4821",
  "••4821",
  "$ 10.236",
  "COP",
  "$ 10.236",
  "Tipo de cambio de PayPal: 1 COP = 0,00029 USD",
  "Tipo de cambio de PayPal: 1 COP = 0,00029 USD",
  "Si continúas, autorizas a PayPal a cobrar el importe de $ 10.236 en tu tarjeta.",
];

/**
 * A frame PayPal's page loads and never shows, as its checkout does for risk and messaging: its
 * source holds numbers that are no amount on the page.
 */
export const HIDDEN_FRAME = `<iframe style="display:none" srcdoc="<body><p>Comisión $ 25.000</p><script>window.cfg={limit:'$ 99.999'}</script></body>"></iframe>`;
