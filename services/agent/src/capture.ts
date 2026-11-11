import type { Page } from "playwright";
import { type Context, plain, scan, type Token, values } from "./amounts.ts";

/** A row of a page holding a number: its text, the region it sits in and its test id. */
export interface Row {
  text: string;
  region: string;
  testid: string;
}

/**
 * One number on a page a pay action was held on, kept for the job log with nothing of the buyer's:
 * the amount exactly as written only when a currency mark names it as money, and of the rest only
 * checkout words, currency codes and the shape of numbers.
 */
export interface Seen {
  /** The number and its currency marks; its digits as `#` unless a currency mark is next to it. */
  amount: string;
  kind: Token["kind"];
  context: Context;
  /** The text before it in its row, back to the number before it; any word not kept as `▪`. */
  label: string;
  /** The ARIA role or landmark it sits in and its test id, kept to checkout words. */
  region: string;
}

/**
 * Words a checkout's own interface writes, in the languages PayPal and Shopify offer checkout
 * in. Anything else in a row (a name, an email, an address, a store's product) is redacted.
 */
const VOCABULARY = new Set(
  `total subtotal sub-total tax taxes estimated shipping delivery discount order item items
  quantity qty amount pay paying now with and of the to in for your you you'll be charged
  charge balance available rewards points exchange conversion currency options
  review continue cancel fee fees card account paypal visa mastercard amex credit
  debit ending preferred method payment payments cart purchase complete agree digital
  download interest installments later merchant seller receives
  or no due today pending converted from using information
  impuestos impuesto iva envío envio entrega descuento pedido resumen artículo artículos cantidad
  precio importe monto pagar pagas pagarás pague paga ahora con y de del la el los las a en para tu
  su se cobrará cobro cargo saldo disponible recompensas puntos tasa tipo cambio conversión moneda
  opciones ver cambiar revisar continuar volver cancelar comisión gratis tarjeta banco cuenta
  crédito débito terminada termina preferido método pago pagos carrito compra completar aceptar
  términos descarga cuotas después comprar tienda vendedor recibe recibirá detalles mostrar
  ocultar más menos por al que o sin hoy pendiente convertido usando información
  pagamento frete imposto impostos desconto taxa câmbio conversão moeda cartão conta você vai
  sous-total taxes livraison remise commande payer solde taux devise carte compte montant
  gesamt zwischensumme steuer mwst versand rabatt bestellung bezahlen guthaben wechselkurs währung
  karte konto summe betrag`
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => fold(w)),
);
const ISO: ReadonlySet<string> = new Set(Intl.supportedValuesOf("currency"));
/** The currency codes a label keeps; any other three capitals may be a name (ANG, BOB, RON). */
const CODES: ReadonlySet<string> = new Set(
  "USD EUR GBP COP MXN BRL ARS CLP JPY CNY INR KRW CAD AUD CHF".split(" "),
);

function fold(word: string): string {
  return word.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** A word of a row as the log may keep it: a checkout word, a currency code, or redacted. */
function keep(word: string): string {
  const bare = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (bare === "") return word;
  if (CODES.has(bare) || VOCABULARY.has(fold(bare))) return word;
  if (/^[\d.,'’ ]+$/u.test(bare)) return "#";
  return "▪";
}

/** A label as the log may keep it: checkout words and currency codes, numbers as `#`. */
function redact(label: string): string {
  return label
    .split(" ")
    .map(keep)
    .join(" ")
    .replace(/▪(?:[\s▪]*▪)?/gu, "▪")
    .trim();
}

/**
 * The marks of a token the log may keep: a currency sign with at most three letters (US$), an
 * ISO code, or a currency name the reader matched as such; anything else is `?`.
 */
const mark = (m: string) =>
  ISO.has(m) || /^\p{Lu}{0,3}\p{Sc}\p{Lu}{0,3}$/u.test(m) || /^\p{Sc}$/u.test(m) ? m : "?";

/**
 * The token as the log may keep it: marks and number, its digits as `#` unless it is money: a
 * currency mark next to a number some locale writes as an amount.
 */
function amountOf(token: Token): string {
  const digits = token.number.replace(/\D/g, "").length;
  // A sign names money; a code alone ("4242 USD" may be a card's last digits) only with cents.
  const sign = token.marks.some((m) => /\p{Sc}/u.test(m));
  const code = token.marks.some((m) => ISO.has(m));
  const money =
    token.kind !== "plain" &&
    (sign || (code && /[.,٫]\d\d$/u.test(token.number))) &&
    [0, 2, 3].some((f) => values(token.number, f).length > 0);
  let out = token.text;
  for (const m of token.marks) out = out.replace(m, mark(m));
  return money && digits <= 9 ? out : out.replace(/\d/g, "#");
}

/** The ARIA roles and landmark elements a row's region is named by. */
const ROLES: ReadonlySet<string> = new Set(
  `banner main complementary contentinfo navigation region form dialog alertdialog table row cell
  rowgroup list listitem group button link heading status alert header aside footer nav section li
  tr`.split(/\s+/),
);

/** A test id kept to its checkout words (`cart-total`), any other part as `*`. */
function identifier(id: string): string {
  if (id === "") return "";
  return id
    .split(/[-_\s.:]+|(?<=\p{Ll})(?=\p{Lu})/u)
    .map((w) => (VOCABULARY.has(fold(w)) ? w.toLowerCase() : "*"))
    .join("-");
}

/**
 * Each number in `rows` that may be money, with its row's label and region, every word that is
 * not a checkout word, a currency code or an amount redacted.
 */
export function sanitize(rows: readonly Row[], locale: string, currency: string): Seen[] {
  const out: Seen[] = [];
  for (const row of rows) {
    const text = plain(row.text);
    const tokens = scan(text, locale, currency);
    const region = [ROLES.has(row.region) ? row.region : "", identifier(row.testid)]
      .filter(Boolean)
      .join(" ");
    for (const token of tokens) {
      if (token.kind === "plain") continue;
      out.push({
        amount: amountOf(token),
        kind: token.kind,
        context: token.context,
        label: redact(token.label),
        region,
      });
    }
  }
  return out;
}

/**
 * Every visible row of the page's frames that holds a digit: the nearest element whose text has
 * words besides the number, its region (ARIA role or landmark) and its `data-testid`.
 */
export async function rows(page: Page): Promise<Row[]> {
  const frames = await Promise.all(
    page.frames().map((f) =>
      f
        .evaluate(() => {
          const out: { text: string; region: string; testid: string }[] = [];
          const taken = new Set<Element>();
          const marks = /\p{Lu}{0,3}\p{Sc}|\p{Lu}{3}/gu;
          // biome-ignore lint/performance/useDomNodeTextContent: the text as the buyer sees it, as the gate reads it.
          const shown = (e: HTMLElement) => e.innerText;
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n && out.length < 80; n = walker.nextNode()) {
            if (!/\p{Nd}/u.test(n.nodeValue ?? "")) continue;
            let el = n.parentElement;
            if (!el?.checkVisibility()) continue;
            for (
              let i = 0;
              i < 4 &&
              el.parentElement &&
              shown(el.parentElement).length <= 120 &&
              !/\p{L}{2}/u.test(shown(el).replace(marks, ""));
              i++
            ) {
              el = el.parentElement;
            }
            if (taken.has(el)) continue;
            taken.add(el);
            const region = el.closest(
              "[role], header, main, aside, footer, nav, section, form, table, dialog, li, tr",
            );
            out.push({
              text: shown(el).slice(0, 300),
              region: region ? (region.getAttribute("role") ?? region.localName) : "",
              testid: el.closest("[data-testid]")?.getAttribute("data-testid") ?? "",
            });
          }
          return out;
        })
        .catch(() => []),
    ),
  );
  return frames.flat();
}
