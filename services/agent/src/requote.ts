import { type CheckoutTotal, checkoutTotal } from "@keelson/core";

/**
 * Words checkouts label a line with, as Shopify's and PayPal's checkouts write them in the
 * languages they are offered in. Words of scripts without spaces are matched anywhere in a label;
 * the others only as whole words.
 */
const WORDS = {
  tax: [
    "tax",
    "taxes",
    "vat",
    "gst",
    "hst",
    "pst",
    "qst",
    "impuesto",
    "impuestos",
    "iva",
    "igv",
    "tva",
    "taxe",
    "mwst",
    "ust",
    "steuer",
    "steuern",
    "imposta",
    "imposte",
    "imposto",
    "impostos",
    "btw",
    "moms",
    "alv",
    "dph",
    "áfa",
    "podatek",
    "vergi",
    "kdv",
    "налог",
    "ндс",
    "מע״מ",
    "מס",
    "ضريبة",
    "الضريبة",
    "ภาษี",
    "세금",
    "부가세",
    "税",
  ],
  shipping: [
    "shipping",
    "delivery",
    "postage",
    "envío",
    "envio",
    "entrega",
    "livraison",
    "expédition",
    "versand",
    "lieferung",
    "porto",
    "spedizione",
    "consegna",
    "frete",
    "portes",
    "verzending",
    "verzendkosten",
    "frakt",
    "fragt",
    "toimitus",
    "doprava",
    "wysyłka",
    "dostawa",
    "kargo",
    "доставка",
    "משלוח",
    "شحن",
    "الشحن",
    "การจัดส่ง",
    "배송",
    "送料",
    "配送",
    "运费",
    "運費",
  ],
} as const;

type Part = keyof typeof WORDS;

const SPACED = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u;

/**
 * Where in `label` any of `words` last ends, or -1. Words of scripts without spaces are matched
 * anywhere; the others only as whole words.
 *
 * @internal
 */
export function wordEnd(label: string, words: readonly string[]): number {
  let end = -1;
  for (const word of words) {
    const pattern = SPACED.test(word)
      ? new RegExp(`(?<!\\p{L})${word}(?!\\p{L})`, "giu")
      : new RegExp(word, "gu");
    for (const m of label.matchAll(pattern)) end = Math.max(end, m.index + m[0].length);
  }
  return end;
}

const lastEnd = (label: string, part: Part) => wordEnd(label, WORDS[part]);

/** Where in `label` a tax or shipping word last ends, or -1. @internal */
export const partEnd = (label: string): number =>
  Math.max(lastEnd(label.toLowerCase(), "tax"), lastEnd(label.toLowerCase(), "shipping"));

/**
 * The part of a checkout a page's label names: tax, shipping or neither. When a label names both,
 * as a line with no amount of its own ("Shipping Free") followed by the next one's label does, the
 * word nearest the amount decides.
 *
 * @internal
 */
export function partOf(label: string): Part | undefined {
  const text = label.normalize("NFKC").toLowerCase();
  const tax = lastEnd(text, "tax");
  const shipping = lastEnd(text, "shipping");
  if (tax < 0 && shipping < 0) return undefined;
  return tax > shipping ? "tax" : "shipping";
}

/**
 * The checkout total a page shows once the buyer's address is known: the countersigned items and
 * discount, which the store's cart still holds, with the tax and shipping the page labels, adding
 * up exactly to its largest amount, which is its total. Undefined unless the page was read for
 * sure and its amounts make up exactly that: one tax amount at most, one shipping amount at most,
 * and nothing else between the items and the total.
 */
export function requote(
  base: CheckoutTotal,
  page: { minor: readonly number[]; labels: readonly string[]; unsure?: string },
): CheckoutTotal | undefined {
  if (page.unsure !== undefined || page.minor.length === 0) return undefined;
  const total = Math.max(...page.minor);
  const found: Record<Part, Set<number>> = { tax: new Set(), shipping: new Set() };
  for (const [i, minor] of page.minor.entries()) {
    const part = partOf(page.labels[i] ?? "");
    if (part && minor !== total) found[part].add(minor);
  }
  if (found.tax.size > 1 || found.shipping.size > 1) return undefined;
  const [tax = 0] = found.tax;
  const [shipping = 0] = found.shipping;
  if (base.items - base.discount + tax + shipping !== total) return undefined;
  return checkoutTotal(base.currency, {
    items: base.items,
    tax,
    shipping,
    discount: base.discount,
  });
}
