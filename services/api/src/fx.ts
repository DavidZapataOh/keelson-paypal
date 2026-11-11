import {
  CURRENCIES,
  commitReference,
  decimalOf,
  type FxReference,
  type Json,
  jcs,
  sha256,
  toHex,
} from "@keelson/core";
import type { RedisClientType } from "redis";

/**
 * Reference mid-market rates come from ExchangeRate-API's open access endpoint
 * (https://www.exchangerate-api.com/docs/free): free, with no key, over 160 currencies (the
 * European Central Bank's daily reference rates cover about 30 and leave out COP, KWD and most of
 * Latin America and the Gulf), updated once a day from several central bank and commercial
 * sources. Its terms allow caching and require attribution; the rates are not redistributed: an
 * Alibi discloses only the one rate its conversion used.
 *
 * The trust model: one third party, fetched by the API over TLS, cached for an hour as its docs
 * ask, and bound into the purchase's evidence, so the countersignature fixes the rates the gate
 * checked PayPal's against. It bounds PayPal's spread; it prices nothing. Rates more than 48 hours
 * old are not served.
 */
export const PROVIDER = "ExchangeRate-API";
const sourceOf = (base: string) => `https://open.er-api.com/v6/latest/${base}`;
const CACHE_SEC = 3600;
/** How long a reference the API served can be bound into a purchase's evidence. */
const ISSUED_SEC = 6 * 3600;
const MAX_AGE_MS = 48 * 3600_000;

const latestKey = (base: string) => `fx:latest:${base}`;
const issuedKey = (bytes: Uint8Array) => `fx:issued:${toHex(sha256(bytes))}`;

/** The bytes of the evidence item that binds `ref`: its commitment as RFC 8785 JSON. */
export function commitmentBytes(ref: FxReference): Uint8Array {
  return new TextEncoder().encode(jcs(commitReference(ref) as unknown as Json));
}

/** The reference `body` from the provider states, or undefined unless it is a usable one. */
export function referenceOf(body: unknown, base: string, now: Date): FxReference | undefined {
  const b = body as {
    result?: unknown;
    base_code?: unknown;
    time_last_update_unix?: unknown;
    rates?: unknown;
  } | null;
  if (
    b?.result !== "success" ||
    b.base_code !== base ||
    typeof b.time_last_update_unix !== "number" ||
    typeof b.rates !== "object" ||
    b.rates === null
  ) {
    return undefined;
  }
  const asOf = new Date(b.time_last_update_unix * 1000);
  if (!(now.getTime() - asOf.getTime() <= MAX_AGE_MS)) return undefined;
  const rates: Record<string, string> = {};
  for (const [code, rate] of Object.entries(b.rates as Record<string, unknown>)) {
    if (/^[A-Z]{3}$/.test(code) && code !== base && typeof rate === "number" && rate > 0) {
      rates[code] = decimalOf(rate);
    }
  }
  return {
    v: "keelson.fx_reference/1",
    provider: PROVIDER,
    source: sourceOf(base),
    base,
    as_of: asOf.toISOString(),
    fetched_at: now.toISOString(),
    rates,
  };
}

/**
 * The reference rates from `base` to every currency, fetched at most once an hour, and recorded as
 * issued so a countersign accepts them in its evidence; undefined when the provider cannot give
 * current ones.
 */
export async function referenceRates(
  kv: RedisClientType,
  base: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FxReference | undefined> {
  if (!Object.hasOwn(CURRENCIES, base)) return undefined;
  const cached = await kv.get(latestKey(base));
  let ref = cached ? (JSON.parse(cached) as FxReference) : undefined;
  if (!ref || Date.now() - Date.parse(ref.as_of) > MAX_AGE_MS) {
    const res = await fetchImpl(sourceOf(base), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
    ref = res?.ok ? referenceOf(await res.json().catch(() => null), base, new Date()) : undefined;
    if (!ref) return undefined;
    await kv.set(latestKey(base), JSON.stringify(ref), { EX: CACHE_SEC });
  }
  await kv.set(issuedKey(commitmentBytes(ref)), "1", { EX: ISSUED_SEC });
  return ref;
}

/** Whether `bytes` is the evidence item of a reference the API issued in the last hours. */
export async function issuedReference(kv: RedisClientType, bytes: Uint8Array): Promise<boolean> {
  return (await kv.exists(issuedKey(bytes))) === 1;
}
