import { KeelsonError } from "./errors.ts";

/** An amount: `"$120"`, `"120.50 USD"`, or minor units of a currency. */
export type Amount = string | { currency: string; minor: number };

const digits = (currency: string) =>
  new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
    .maximumFractionDigits ?? 2;

/** The amount in minor units of its currency (USD when written with `$`). */
export function minorOf(amount: Amount): { currency: string; minor: number } {
  if (typeof amount !== "string") return amount;
  const m = /^\s*(\$)?\s*(\d+(?:\.\d+)?)\s*([A-Z]{3})?\s*$/.exec(amount);
  if (!m || (!m[1] && !m[3])) {
    throw new KeelsonError(`Write the amount as "$120" or "120 USD", not "${amount}".`);
  }
  const currency = m[3] ?? "USD";
  const [whole, frac = ""] = (m[2] as string).split(".");
  const d = digits(currency);
  if (frac.length > d) throw new KeelsonError(`${currency} has ${d} decimal places: "${amount}".`);
  return { currency, minor: Number(whole) * 10 ** d + Number(frac.padEnd(d, "0") || "0") };
}

/** The PayPal Orders v2 `value` of an amount in minor units. */
export function paypalValue(currency: string, minor: number): string {
  const d = digits(currency);
  if (d === 0) return String(minor);
  const s = String(minor).padStart(d + 1, "0");
  return `${s.slice(0, -d)}.${s.slice(-d)}`;
}

/** An ISO date, a `Date`, or a duration from now such as `"30m"`, `"1h"`, `"7d"`. */
export type Until = string | Date;

export function isoOf(until: Until): string {
  if (until instanceof Date) return until.toISOString();
  const d = /^(\d+)\s*(m|h|d)$/.exec(until.trim());
  if (d) {
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[d[2] as "m" | "h" | "d"];
    return new Date(Date.now() + Number(d[1]) * ms).toISOString();
  }
  const t = Date.parse(until);
  if (Number.isNaN(t))
    throw new KeelsonError(`Write the end as an ISO date or "1h", not "${until}".`);
  return new Date(t).toISOString();
}
