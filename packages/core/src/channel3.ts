import type { Json } from "./jcs.ts";
import { CURRENCIES, type CurrencyCode, fromPayPalValue } from "./money.ts";

/** One selected variant option, as Channel3's `variants.selected` names it. */
export interface VariantOption {
  name: string;
  label: string;
}

/** What the agent saw on the product page, read from the capture's `api.product` item. */
export interface AgentView {
  /** The `content_hash` of the `api.product` item this view was read from. */
  contentHash: `0x${string}`;
  url: string;
  brand?: string;
  /** An integer string in minor units. */
  priceMinor: string;
  currency: CurrencyCode;
  available: boolean;
  selected: VariantOption[];
}

export interface Channel3Offer {
  domain: string;
  /** An integer string in minor units, or `""` when the price cannot be read exactly. */
  priceMinor: string;
  currency: string;
  availability: string;
}

/** The fields of a Channel3 `Product` the comparison reads. */
export interface Channel3Product {
  id: string;
  title: string;
  brand: string | null;
  selected: VariantOption[];
  offers: Channel3Offer[];
}

export type Channel3Result = "match" | "mismatch" | "unknown";

export interface Channel3Comparison {
  /** The offer on the page's domain, or `null` when Channel3 lists none. */
  offerDomain: string | null;
  variant: Channel3Result;
  price: Channel3Result;
  availability: Channel3Result;
  brand: Channel3Result;
  /** The attributes that differ, in comparison order. */
  mismatches: string[];
}

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * A Channel3 price, a JSON number in major units, as an integer string in minor units. The number
 * is formatted to the currency's exponent and parsed as a decimal string, never multiplied as a
 * float; a price that does not round-trip, or an unsupported currency, gives `""`.
 */
export function channel3PriceMinor(price: unknown, currency: string): string {
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return "";
  if (!Object.hasOwn(CURRENCIES, currency)) return "";
  const code = currency as CurrencyCode;
  const { exponent, integerOnly } = CURRENCIES[code];
  let value = price.toFixed(exponent);
  if (Number(value) !== price) return "";
  if (integerOnly) value = value.replace(/\.0+$/, "");
  try {
    return fromPayPalValue(code, value).minor.toString();
  } catch {
    return "";
  }
}

function options(v: unknown): VariantOption[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((o) => {
    const name = str(record(o)?.name);
    const label = str(record(o)?.label);
    return name !== null && label !== null ? [{ name, label }] : [];
  });
}

/** Reads the compared fields out of a Channel3 `Product`. */
export function normalizeProduct(product: unknown): Channel3Product {
  const p = record(product);
  const id = str(p?.id);
  const title = str(p?.title);
  if (!p || id === null || title === null) throw new TypeError("not a Channel3 product");
  const brands = Array.isArray(p.brands) ? p.brands : [];
  const offers = (Array.isArray(p.offers) ? p.offers : []).flatMap((o) => {
    const offer = record(o);
    const price = record(offer?.price);
    const domain = str(offer?.domain);
    const currency = str(price?.currency);
    if (domain === null || currency === null) return [];
    return [
      {
        domain,
        priceMinor: channel3PriceMinor(price?.price, currency),
        currency,
        availability: str(offer?.availability) ?? "",
      },
    ];
  });
  return {
    id,
    title,
    brand: str(record(brands[0])?.name),
    selected: options(record(p.variants)?.selected),
    offers,
  };
}

/** Unicode NFKC, trimmed and case-folded. */
const fold = (s: string) => s.normalize("NFKC").trim().toUpperCase().toLowerCase();
const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, "");

function hostOf(url: string): string | null {
  try {
    return bareHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

function compareVariant(agent: VariantOption[], channel3: VariantOption[]): Channel3Result {
  if (agent.length === 0) return "unknown";
  let result: Channel3Result = "match";
  for (const option of agent) {
    const theirs = channel3.find((o) => fold(o.name) === fold(option.name));
    if (!theirs) result = "unknown";
    else if (fold(theirs.label) !== fold(option.label)) return "mismatch";
  }
  return result;
}

/**
 * Compares what the agent saw with Channel3's product, field by field. The offer compared is the
 * one on the page's own domain. Title is not compared: stores and catalogs word it differently.
 */
export function compareChannel3(
  view: AgentView,
  product: Channel3Product | null,
): Channel3Comparison {
  const host = hostOf(view.url);
  const offer = product?.offers.find((o) => host !== null && bareHost(o.domain) === host) ?? null;
  const variant = product ? compareVariant(view.selected, product.selected) : "unknown";
  const price: Channel3Result =
    !offer || offer.priceMinor === ""
      ? "unknown"
      : offer.currency === view.currency && offer.priceMinor === view.priceMinor
        ? "match"
        : "mismatch";
  const availability: Channel3Result =
    offer?.availability === "InStock" || offer?.availability === "OutOfStock"
      ? (offer.availability === "InStock") === view.available
        ? "match"
        : "mismatch"
      : "unknown";
  const brand: Channel3Result =
    !view.brand || !product?.brand
      ? "unknown"
      : fold(view.brand) === fold(product.brand)
        ? "match"
        : "mismatch";
  const results = { variant, price, availability, brand };
  return {
    offerDomain: offer?.domain ?? null,
    ...results,
    mismatches: Object.entries(results).flatMap(([k, r]) => (r === "mismatch" ? [k] : [])),
  };
}

/**
 * The evidence sources a comparison adds to the countersign request, as
 * `channel3:<result>:<attribute>:<observation id>`. They are testimony: the engine shows them in
 * the trace and they never change a field's color.
 */
export function channel3Sources(
  id: string,
  c: Channel3Comparison,
): Record<"variant" | "total" | "merchant", string[]> {
  const source = (result: Channel3Result, attribute: string) =>
    `channel3:${result}:${attribute}:${id}`;
  return {
    variant: [
      source(c.variant, "variant"),
      source(c.brand, "brand"),
      source(c.availability, "availability"),
    ],
    total: [source(c.price, "price")],
    merchant: [source(c.offerDomain ? "match" : "unknown", "offer")],
  };
}

/** A stored Channel3 offer event, summarized for an observation. */
export interface Channel3EventSummary {
  id: string;
  type: string;
  /** RFC 3339: when Channel3 committed the change. */
  committedAt: string;
  current: Json;
}

export interface Channel3ObservationInput {
  id: string;
  url: string;
  requestedAtMs: number;
  receivedAtMs: number;
  status: "ok" | "unavailable";
  error?: string;
  httpStatus?: number;
  /** SHA-256 of the exact response bytes, hex with `0x`. */
  responseSha256: `0x${string}`;
  product?: Channel3Product;
  agentView: AgentView;
  comparison: Channel3Comparison;
  webhookEvents?: Channel3EventSummary[];
}

const int = (n: number, what: string) => {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${what} must be a safe integer`);
  return n;
};

/**
 * The `keelson.channel3.observation/1` document: integers and strings only, so its JCS bytes are
 * the same in every implementation.
 */
export function observationDocument(o: Channel3ObservationInput): Json {
  const view = o.agentView;
  return {
    v: "keelson.channel3.observation/1",
    id: o.id,
    url: o.url,
    request: { max_staleness_hours: 1, realtime_fetch: true },
    requested_at_ms: int(o.requestedAtMs, "requested_at_ms"),
    received_at_ms: int(o.receivedAtMs, "received_at_ms"),
    status: o.status,
    ...(o.error !== undefined ? { error: o.error } : {}),
    ...(o.httpStatus !== undefined ? { http_status: int(o.httpStatus, "http_status") } : {}),
    response_sha256: o.responseSha256,
    ...(o.product
      ? {
          product: {
            id: o.product.id,
            title: o.product.title,
            brand: o.product.brand,
            selected: o.product.selected.map((s) => ({ name: s.name, label: s.label })),
            offers: o.product.offers.map((f) => ({
              domain: f.domain,
              price_minor: f.priceMinor,
              currency: f.currency,
              availability: f.availability,
            })),
          },
        }
      : {}),
    agent_view: {
      content_hash: view.contentHash,
      url: view.url,
      ...(view.brand !== undefined ? { brand: view.brand } : {}),
      price_minor: view.priceMinor,
      currency: view.currency,
      available: view.available,
      selected: view.selected.map((s) => ({ name: s.name, label: s.label })),
    },
    comparison: {
      offer_domain: o.comparison.offerDomain,
      variant: o.comparison.variant,
      price: o.comparison.price,
      availability: o.comparison.availability,
      brand: o.comparison.brand,
      mismatches: o.comparison.mismatches,
    },
    webhook_events: (o.webhookEvents ?? []).map((e) => ({
      id: e.id,
      type: e.type,
      committed_at: e.committedAt,
      current: e.current,
    })),
  };
}
