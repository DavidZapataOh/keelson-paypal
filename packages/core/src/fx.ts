/**
 * Currency conversion at a checkout: the merchant charges in its currency, and PayPal converts that
 * amount into the buyer's currency at a rate it shows. Amounts and rates are decimal strings, as
 * the page writes them once their grouping is removed (`10231`, `3468.14`); every comparison is
 * exact integer arithmetic on them.
 */

/** The spread over the reference rate a mandate allows when it names none, in basis points. */
export const DEFAULT_MAX_SPREAD_BPS = 750;

/** Mid-market rates from a reference source, as the API fetched them: `1 base = rates[c] c`. */
export interface FxReference {
  v: "keelson.fx_reference/1";
  /** Who publishes the rates. */
  provider: string;
  /** The URL the API fetched. */
  source: string;
  base: string;
  /** When the provider last updated the rates, ISO 8601. */
  as_of: string;
  /** When the API fetched them, ISO 8601. */
  fetched_at: string;
  rates: Record<string, string>;
}

/** A charge converted into the buyer's currency, as PayPal showed it and as the reference prices it. */
export interface Conversion {
  v: "keelson.conversion/1";
  /** What the merchant charges: the countersigned total. */
  merchant: { currency: string; value: string };
  /** What PayPal charges the buyer, with as many decimals as it showed. */
  buyer: { currency: string; value: string };
  /** PayPal's rate: 1 merchant unit is `rate` buyer units, with as many decimals as it showed. */
  rate: string;
  reference: { rate: string; provider: string; source: string; as_of: string };
  /** How far PayPal's rate is from the reference, rounded up, in basis points. */
  spread_bps: number;
  max_spread_bps: number;
  /** The locale the page wrote the buyer's amount and rate in. */
  locale: string;
}

const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/** A decimal string as an integer and its scale: `"3468.14"` is `346814n` and 2. */
export function decimalParts(s: string): { int: bigint; scale: number } {
  const m = DECIMAL.exec(s);
  if (!m || s.length > 40) throw new RangeError(`not a decimal: ${s}`);
  const fraction = m[2] ?? "";
  return { int: BigInt(`${m[1]}${fraction}`), scale: fraction.length };
}

/** A positive finite number as a plain decimal string, never in exponent notation. */
export function decimalOf(n: number): string {
  if (!Number.isFinite(n) || n <= 0) throw new RangeError(`not a positive rate: ${n}`);
  const s = String(n);
  return /e/i.test(s) ? n.toFixed(20).replace(/\.?0+$/, "") : s;
}

const pow10 = (n: number) => 10n ** BigInt(n);
const abs = (n: bigint) => (n < 0n ? -n : n);

/**
 * Whether `buyer` is `merchant` converted at `rate`, up to how the page rounded them: PayPal rounds
 * the buyer's amount to the last digit it shows, which in whatever rounding mode moves it by less
 * than one of that digit, and the rate it shows to its last digit, which moves the product by at
 * most half of that digit times the merchant amount. Nothing else is allowed:
 * `|buyer − merchant × rate| ≤ 10^−buyerDecimals + merchant × 10^−rateDecimals / 2`. A rate shown
 * with fewer than {@link RATE_DIGITS} significant digits is refused, so the rate's rounding is
 * under 0.05% of the amount.
 */
export function convertsTo(merchant: string, rate: string, buyer: string): boolean {
  const { diff, bound, zero } = gap(merchant, rate, buyer);
  return !zero && abs(diff) <= bound;
}

/** Whether `buyer` is more than `merchant` converted at `rate` can be, as {@link convertsTo} bounds it. */
export function exceedsConversion(merchant: string, rate: string, buyer: string): boolean {
  const { diff, bound, zero } = gap(merchant, rate, buyer);
  return zero || diff > bound;
}

/** The significant digits a rate must show: its rounding is then at most 0.5 in 1,000. */
export const RATE_DIGITS = 4;

/** `buyer − merchant × rate` and the rounding bound, both times 2 × 10^(m + r + b): integers. */
function gap(merchant: string, rate: string, buyer: string) {
  const m = decimalParts(merchant);
  const r = decimalParts(rate);
  const b = decimalParts(buyer);
  return {
    diff: 2n * b.int * pow10(m.scale + r.scale) - 2n * m.int * r.int * pow10(b.scale),
    bound: 2n * pow10(m.scale + r.scale) + m.int * pow10(b.scale),
    zero: r.int.toString().length < RATE_DIGITS,
  };
}

/** How far `rate` is from `reference`, `|rate − reference| / reference`, in basis points rounded up. */
export function spreadBps(rate: string, reference: string): number {
  const r = decimalParts(rate);
  const ref = decimalParts(reference);
  if (ref.int === 0n) throw new RangeError("a reference rate of zero");
  const scale = Math.max(r.scale, ref.scale);
  const a = r.int * pow10(scale - r.scale);
  const b = ref.int * pow10(scale - ref.scale);
  const num = abs(a - b) * 10_000n;
  return Number((num + b - 1n) / b);
}

/**
 * Why `c` does not hold together, or undefined when it does: another currency, an amount that is
 * not the merchant's at PayPal's rate, a spread that is not the one its rates give, or over its cap.
 */
export function conversionProblem(c: Conversion): string | undefined {
  try {
    if (c.buyer.currency === c.merchant.currency)
      return "the buyer pays in the merchant's currency";
    if (!convertsTo(c.merchant.value, c.rate, c.buyer.value)) {
      return "the buyer's amount is not the merchant's at PayPal's rate";
    }
    if (spreadBps(c.rate, c.reference.rate) !== c.spread_bps) {
      return "the spread is not the one PayPal's and the reference rates give";
    }
    if (c.spread_bps > c.max_spread_bps) return "the spread is over the mandate's cap";
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * The conversion as a receipt states it: `Paid 10.231 COP (USD 2.95 at 3.468,14)`, the buyer's
 * amount and PayPal's rate in the page's locale, with the decimals PayPal showed.
 */
export function describeConversion(c: Conversion): string {
  const locale = Intl.NumberFormat.supportedLocalesOf(c.locale)[0] ?? "en";
  const show = (value: string, l: string) => {
    const digits = decimalParts(value).scale;
    return new Intl.NumberFormat(l, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(Number(value));
  };
  return `Paid ${show(c.buyer.value, locale)} ${c.buyer.currency} (${c.merchant.currency} ${show(c.merchant.value, "en")} at ${show(c.rate, locale)})`;
}
