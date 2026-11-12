import { contextOf, type PageReading } from "./amounts.ts";

/**
 * Labels of charges a checkout may add on top of the items, tax and shipping Keelson
 * countersigns: fees, surcharges, tips, donations, insurance, protection plans and warranties, in
 * the languages checkouts are written in.
 */
const WORDS = [
  "fees?",
  "surcharges?",
  "service charge",
  "payment handling",
  "convenience",
  "tips?",
  "gratuity",
  "donation",
  "charity",
  "insurance",
  "protection",
  "warranty",
  "cargos? (?:por|de) servicio",
  "comisi[oó]n",
  "propina",
  "donaci[oó]n",
  "seguro de env[ií]o",
  "taxa de (?:servi[cç]o|conveni[eê]ncia)",
  "gorjeta",
  "doa[cç][aã]o",
  "\\p{L}*geb[uü]hr\\p{L}*",
  "aufschlag",
  "trinkgeld",
  "spende",
  "versicherung",
  "frais",
  "suppl[eé]ment",
  "pourboire",
  "commissione",
  "supplemento",
  "mancia",
];
/** Scripts written without spaces between words: matched anywhere in the label. */
const UNSPACED = ["手数料", "チップ", "寄付", "保険", "服务费", "手续费", "رسوم", "عمولة"];
const FEE = new RegExp(`(?<!\\p{L})(?:${WORDS.join("|")})(?!\\p{L})|${UNSPACED.join("|")}`, "iu");
/** Words whose amount is no charge: a fee waived or free. */
const NO_CHARGE =
  /(?<!\p{L})(?:waived|free|sin|sem|ohne|sans|gratis|gratuit[oa]?|kostenlos)(?!\p{L})/iu;
/** How far back from its amount a label names it. */
const LABEL_TAIL = 32;

/**
 * The label of a nonzero amount the page reading names as a fee or another add-on Keelson never
 * countersigns, or undefined.
 */
export function addedCharge(read: PageReading): string | undefined {
  for (const [i, minor] of read.minor.entries()) {
    const label = (read.labels[i] ?? "").slice(-LABEL_TAIL);
    if (
      minor > 0 &&
      FEE.test(label) &&
      !NO_CHARGE.test(label) &&
      contextOf(label, "line") !== "total"
    ) {
      return label.trim();
    }
  }
  return undefined;
}
