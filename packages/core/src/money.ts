export interface CurrencyInfo {
  /** ISO 4217 numeric code. */
  readonly numeric: number;
  /** ISO 4217 minor-unit exponent. */
  readonly exponent: 0 | 2;
  /** PayPal accepts whole major units only (no decimal places). */
  readonly integerOnly: boolean;
}

/** Currencies supported by the PayPal REST API, with ISO 4217 codes and PayPal's decimal rules. */
export type CurrencyCode =
  | "AUD"
  | "BRL"
  | "CAD"
  | "CNY"
  | "CZK"
  | "DKK"
  | "EUR"
  | "HKD"
  | "HUF"
  | "ILS"
  | "JPY"
  | "MYR"
  | "MXN"
  | "TWD"
  | "NZD"
  | "NOK"
  | "PHP"
  | "PLN"
  | "GBP"
  | "SGD"
  | "SEK"
  | "CHF"
  | "THB"
  | "USD";

export const CURRENCIES: Readonly<Record<CurrencyCode, CurrencyInfo>> = {
  AUD: { numeric: 36, exponent: 2, integerOnly: false },
  BRL: { numeric: 986, exponent: 2, integerOnly: false },
  CAD: { numeric: 124, exponent: 2, integerOnly: false },
  CNY: { numeric: 156, exponent: 2, integerOnly: false },
  CZK: { numeric: 203, exponent: 2, integerOnly: false },
  DKK: { numeric: 208, exponent: 2, integerOnly: false },
  EUR: { numeric: 978, exponent: 2, integerOnly: false },
  HKD: { numeric: 344, exponent: 2, integerOnly: false },
  HUF: { numeric: 348, exponent: 2, integerOnly: true },
  ILS: { numeric: 376, exponent: 2, integerOnly: false },
  JPY: { numeric: 392, exponent: 0, integerOnly: true },
  MYR: { numeric: 458, exponent: 2, integerOnly: false },
  MXN: { numeric: 484, exponent: 2, integerOnly: false },
  TWD: { numeric: 901, exponent: 2, integerOnly: true },
  NZD: { numeric: 554, exponent: 2, integerOnly: false },
  NOK: { numeric: 578, exponent: 2, integerOnly: false },
  PHP: { numeric: 608, exponent: 2, integerOnly: false },
  PLN: { numeric: 985, exponent: 2, integerOnly: false },
  GBP: { numeric: 826, exponent: 2, integerOnly: false },
  SGD: { numeric: 702, exponent: 2, integerOnly: false },
  SEK: { numeric: 752, exponent: 2, integerOnly: false },
  CHF: { numeric: 756, exponent: 2, integerOnly: false },
  THB: { numeric: 764, exponent: 2, integerOnly: false },
  USD: { numeric: 840, exponent: 2, integerOnly: false },
};

/** An amount in minor units; never a float. */
export interface Money {
  currency: CurrencyCode;
  minor: bigint;
}

const AMOUNT = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

function info(currency: CurrencyCode): CurrencyInfo {
  if (!Object.hasOwn(CURRENCIES, currency))
    throw new TypeError(`unsupported currency: ${currency}`);
  return CURRENCIES[currency];
}

export function currencyNumeric(c: CurrencyCode): number {
  return info(c).numeric;
}

/** Formats an amount as the decimal string PayPal expects, e.g. `"94.00"` or `"94"` for JPY. */
export function toPayPalValue(m: Money): string {
  const { exponent, integerOnly } = info(m.currency);
  const scale = 10n ** BigInt(exponent);
  const abs = m.minor < 0n ? -m.minor : m.minor;
  const sign = m.minor < 0n ? "-" : "";
  const whole = abs / scale;
  const frac = abs % scale;
  if (integerOnly) {
    if (frac !== 0n) throw new RangeError(`${m.currency} does not allow fractional amounts`);
    return `${sign}${whole}`;
  }
  return exponent === 0
    ? `${sign}${whole}`
    : `${sign}${whole}.${frac.toString().padStart(exponent, "0")}`;
}

/** Parses a PayPal decimal string into minor units without going through a float. */
export function fromPayPalValue(currency: CurrencyCode, value: string): Money {
  const { exponent, integerOnly } = info(currency);
  const match = AMOUNT.exec(value);
  if (!match) throw new SyntaxError(`invalid amount: ${value}`);
  const [, sign, whole, frac = ""] = match;
  const maxDecimals = integerOnly ? 0 : exponent;
  if (frac.length > maxDecimals) throw new RangeError(`too many decimal places for ${currency}`);
  const scale = 10n ** BigInt(exponent);
  const minor = BigInt(whole as string) * scale + BigInt(frac.padEnd(exponent, "0") || "0");
  if (sign && minor === 0n) throw new SyntaxError(`invalid amount: ${value}`);
  return { currency, minor: sign ? -minor : minor };
}
