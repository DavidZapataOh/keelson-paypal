import type { Cart, Money } from "@keelson/core";

/** RunFast's id in Keelson's merchant directory. @internal */
export const MERCHANT_ID = "mrc_runfast";
export const BRAND = "RunFast";
export const CURRENCY = "USD";
const RETURN_DAYS = 30;

export interface Product {
  handle: string;
  sku: string;
  title: string;
  category: "shoes" | "bundle";
  color: string;
  /** Where the shoe is meant to run. */
  terrain: "Road" | "Trail" | "Race" | "Race kit";
  /** The illustration's upper, midsole and accent colors. */
  paint: { upper: string; sole: string; accent: string };
  description: string;
  priceMinor: number;
  sizes: string[];
}

/** Google Product Taxonomy ids, the categories mandates allow: Shoes and Sporting Goods. */
const TAXONOMY: Record<Product["category"], string> = { shoes: "gpt:187", bundle: "gpt:988" };

const SIZES = ["7", "8", "9", "10", "11", "12"];

export const PRODUCTS: readonly Product[] = [
  {
    handle: "tempo-3",
    sku: "RF-TMP3",
    title: "Tempo 3",
    category: "shoes",
    color: "blue",
    terrain: "Road",
    paint: { upper: "#2f5bd3", sole: "#f4f3ef", accent: "#e4f23c" },
    description:
      "A responsive daily trainer with a nitrogen-infused foam midsole and an 8 mm drop, built for tempo runs and long miles alike.",
    priceMinor: 12900,
    sizes: SIZES,
  },
  {
    handle: "trail-runner-2",
    sku: "RF-TRL2",
    title: "Trail Runner 2",
    category: "shoes",
    color: "green",
    terrain: "Trail",
    paint: { upper: "#2e6b4a", sole: "#d9cfb8", accent: "#f08a24" },
    description:
      "A lightweight trail shoe with 4 mm lugs, a rock plate and a breathable mesh upper that drains fast after stream crossings.",
    priceMinor: 13900,
    sizes: SIZES,
  },
  {
    handle: "carbon-elite",
    sku: "RF-CRBE",
    title: "Carbon Elite",
    category: "shoes",
    color: "white",
    terrain: "Race",
    paint: { upper: "#eef0f2", sole: "#e4f23c", accent: "#16181b" },
    description:
      "Our race-day shoe: a full-length carbon plate in a 39 mm stack of PEBA foam, for 10K to marathon.",
    priceMinor: 24900,
    sizes: SIZES,
  },
  {
    handle: "cloud-daily",
    sku: "RF-CLDD",
    title: "Cloud Daily",
    category: "shoes",
    color: "grey",
    terrain: "Road",
    paint: { upper: "#7b818c", sole: "#f4f3ef", accent: "#2f5bd3" },
    description:
      "Soft, stable and forgiving: a wide base and a plush heel for recovery days and first marathons.",
    priceMinor: 11900,
    sizes: SIZES,
  },
  {
    handle: "ridge-gtx",
    sku: "RF-RDGX",
    title: "Ridge GTX",
    category: "shoes",
    color: "black",
    terrain: "Trail",
    paint: { upper: "#22252b", sole: "#3a3f47", accent: "#e4f23c" },
    description:
      "A waterproof trail shoe with a gusseted tongue and a sticky rubber outsole for winter and wet mountain routes.",
    priceMinor: 15900,
    sizes: SIZES,
  },
  {
    handle: "pace-lite",
    sku: "RF-PACE",
    title: "Pace Lite",
    category: "shoes",
    color: "red",
    terrain: "Road",
    paint: { upper: "#c8382f", sole: "#f4f3ef", accent: "#16181b" },
    description:
      "A light, low-profile trainer for short intervals, strides and the track. 198 g in a men's 9.",
    priceMinor: 9900,
    sizes: SIZES,
  },
  {
    handle: "premium-bundle",
    sku: "RF-PRMB",
    title: "Premium Bundle",
    category: "bundle",
    color: "white",
    terrain: "Race kit",
    paint: { upper: "#eef0f2", sole: "#e4f23c", accent: "#16181b" },
    description:
      "Carbon Elite race shoes with a race belt, two pairs of merino running socks and a reflective vest.",
    priceMinor: 34000,
    sizes: SIZES,
  },
];

const BY_HANDLE = new Map(PRODUCTS.map((p) => [p.handle, p]));

export function product(handle: string): Product | undefined {
  return BY_HANDLE.get(handle);
}

/** `$129.00` */
export function display(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

/** The product as the store's JSON API serves it: what a shopping agent captures. */
export function productJson(p: Product, url: string, description: string = p.description) {
  return {
    merchant: MERCHANT_ID,
    handle: p.handle,
    sku: p.sku,
    title: p.title,
    brand: BRAND,
    category: p.category,
    color: p.color,
    description,
    url,
    price: { currency: CURRENCY, minor: p.priceMinor, display: display(p.priceMinor) },
    available: true,
    sizes: p.sizes,
    return_days: RETURN_DAYS,
    returns_free: true,
  };
}

function variantSku(p: Product, size: string): string {
  return `${p.sku}-${size}`;
}

/**
 * One size of a product as a flat JSON object, keyed by the SKU a cart line carries: the whole body a
 * TLSNotary session commits to when it proves what the store sells under that SKU.
 */
export function variantJson(p: Product, sku: string) {
  const size = p.sizes.find((s) => variantSku(p, s) === sku);
  if (size === undefined) return undefined;
  return { sku, size, color: p.color, unit_minor: p.priceMinor, returns_free: true };
}

export interface LineRequest {
  handle: string;
  size: string;
  qty: number;
}

export interface Quote {
  /** The cart in the shape Keelson's engine hashes and checks. */
  cart: Cart;
  total: Money;
  lines: { product: Product; size: string; qty: number }[];
}

export class QuoteError extends Error {}

const MAX_LINES = 10;
const MAX_QTY = 5;

/** Prices lines from the catalog; nothing in a quote comes from the client but ids and counts. */
export function quote(requested: readonly LineRequest[]): Quote {
  if (requested.length === 0 || requested.length > MAX_LINES) {
    throw new QuoteError(`A cart has 1 to ${MAX_LINES} lines.`);
  }
  const lines = requested.map(({ handle, size, qty }) => {
    const p = product(handle);
    if (!p) throw new QuoteError(`There is no product "${handle}".`);
    if (!p.sizes.includes(size)) throw new QuoteError(`${p.title} has no size "${size}".`);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      throw new QuoteError(`The quantity must be a whole number from 1 to ${MAX_QTY}.`);
    }
    return { product: p, size, qty };
  });
  const total = lines.reduce((sum, l) => sum + BigInt(l.product.priceMinor * l.qty), 0n);
  return {
    cart: {
      merchant: MERCHANT_ID,
      currency: CURRENCY,
      lines: lines.map(({ product: p, size, qty }) => ({
        sku: variantSku(p, size),
        size,
        color: p.color,
        category: TAXONOMY[p.category],
        qty,
        unit_minor: p.priceMinor,
      })),
      return_days: RETURN_DAYS,
      returns_free: true,
    },
    total: { currency: CURRENCY, minor: total },
    lines,
  };
}
