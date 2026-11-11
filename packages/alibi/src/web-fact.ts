import { type Cart, CURRENCIES, type CurrencyCode, fromHex, fromPayPalValue } from "@keelson/core";

/** How long before the countersign the store's endpoint may have been notarized. */
const MAX_AGE_SEC = 900;
/** How far the notary's clock may run ahead of the countersign's. */
const SKEW_SEC = 60;
/** A Shopify product's `.oembed` endpoint. */
const OEMBED_PATH = /^\/products\/[a-z0-9][a-z0-9-]{0,254}\.oembed$/;

/** What of a `tlsn.web_fact` item its binding to a purchase reads. */
export interface WebFactFields {
  url: string;
  web_fact: { tCapture: number };
  committed: string;
}

/** Why a WebFact is not the purchase's, and the Alibi pointers that say so. */
export interface WebFactMismatch {
  reason: string;
  reads: string[];
}

/** The committed object of a Shopify `.oembed` body: one variant's offer. */
interface Offer {
  offer_id?: unknown;
  sku?: unknown;
  price?: unknown;
  currency_code?: unknown;
}

function offerOf(committed: string): Offer | undefined {
  try {
    const v: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(fromHex(committed)),
    );
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Offer) : undefined;
  } catch {
    return undefined;
  }
}

/** The line id the agent gives a variant: its SKU, or its id when it has none. */
function lineId(offer: Offer): string | undefined {
  if (typeof offer.sku === "string" && offer.sku !== "") return offer.sku;
  return Number.isSafeInteger(offer.offer_id) ? String(offer.offer_id) : undefined;
}

function priceOf(offer: Offer, cart: Cart): bigint | undefined {
  const currency = offer.currency_code;
  if (
    typeof currency !== "string" ||
    currency !== cart.currency ||
    !Object.hasOwn(CURRENCIES, currency) ||
    typeof offer.price !== "number"
  ) {
    return undefined;
  }
  try {
    return fromPayPalValue(currency as CurrencyCode, String(offer.price)).minor;
  } catch {
    return undefined;
  }
}

/**
 * Whether a WebFact is the purchase's: the store's `.oembed` product endpoint on the website the
 * mandate allows for the cart's merchant, an offer that is a line of the cart at that line's unit
 * price, notarized at most 15 minutes before `at` (the countersign's time). Returns the line it
 * proves, or why it is not the purchase's.
 */
export function bindWebFact(
  doc: WebFactFields,
  cart: Cart,
  website: string | undefined,
  at: number,
): { line: Cart["lines"][number] } | WebFactMismatch {
  let url: URL;
  try {
    url = new URL(doc.url);
  } catch {
    return { reason: "the WebFact's URL is not a URL", reads: ["/web_fact/url"] };
  }
  if (
    website === undefined ||
    url.origin !== new URL(website).origin ||
    !OEMBED_PATH.test(url.pathname) ||
    url.search !== ""
  ) {
    return {
      reason: "the WebFact is not a product endpoint of the store the mandate allows",
      reads: ["/web_fact/url", "/mandate/payload_sd", "/cart/merchant"],
    };
  }
  const offer = offerOf(doc.committed);
  if (!offer) {
    return { reason: "the committed bytes are not one offer", reads: ["/web_fact/committed"] };
  }
  const id = lineId(offer);
  const price = priceOf(offer, cart);
  const line = cart.lines.find(
    (l) =>
      id !== undefined && l.sku === id && price !== undefined && BigInt(l.unit_minor) === price,
  );
  if (!line) {
    return {
      reason: "the notarized offer is not a line of the cart at its price",
      reads: ["/web_fact/committed", "/cart/lines"],
    };
  }
  const t = doc.web_fact.tCapture;
  if (!(t >= at - MAX_AGE_SEC && t <= at + SKEW_SEC)) {
    return {
      reason: "the WebFact was not notarized for this purchase",
      reads: ["/web_fact/web_fact/tCapture", "/tee/countersign/issuedAt"],
    };
  }
  return { line };
}
