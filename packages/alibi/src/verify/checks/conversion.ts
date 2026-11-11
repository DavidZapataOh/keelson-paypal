import {
  type Conversion,
  CURRENCIES,
  type CurrencyCode,
  conversionProblem,
  currencyNumeric,
  DEFAULT_MAX_SPREAD_BPS,
  type FxReferenceCommitment,
  type Json,
  jcs,
  referenceProblem,
  sha256,
  toHex,
} from "@keelson/core";
import { type CheckDef, expect, pass } from "../check.ts";
import { isBundle, UNDISCLOSED } from "./util.ts";

/**
 * A live purchase PayPal converted to the buyer's currency: the conversion is of the countersigned
 * amount and currency, the buyer's amount is that amount at PayPal's rate up to the page's
 * rounding, the reference rate is the one the disclosed `api.fx_reference` item binds, the spread
 * between PayPal's rate and it is the one stated, and it is within the mandate's
 * `fx.max_spread_bps`. The amounts and PayPal's rate are the agent's reading of PayPal's checkout;
 * this checks that they hold together and that the reference is the evidence's.
 */
export const conversion: CheckDef = {
  id: "evidence.conversion",
  step: 0,
  reads: ["/conversion", "/fx_reference", "/tee/countersign/amount", "/tee/countersign/currency"],
  run(input) {
    if (!isBundle(input)) return UNDISCLOSED;
    const c = input.conversion as Conversion | undefined;
    if (c === undefined) return { status: "absent", reads: ["/conversion"] };
    const committed = input.fx_reference as FxReferenceCommitment | undefined;
    if (committed === undefined) {
      return input.manifest.public.items.some((x) => x.type === "api.fx_reference")
        ? { status: "undisclosed", reads: ["/fx_reference", "/manifest/public/items"] }
        : {
            status: "fail",
            reason: "the conversion's evidence binds no reference rates",
            reads: ["/conversion", "/manifest/public/items"],
          };
    }
    const i = input.manifest.disclosures.findIndex((d) => d.type === "api.fx_reference");
    expect(
      toHex(sha256(new TextEncoder().encode(jcs(committed as unknown as Json)))) ===
        input.manifest.disclosures[i]?.content_hash,
      "the reference rates are not the disclosed item",
      ["/fx_reference", `/manifest/disclosures/${i}/content_hash`],
    );
    const cs = input.tee.countersign;
    const digits = CURRENCIES[c.merchant.currency as CurrencyCode]?.exponent;
    const [whole = "", fraction = ""] = c.merchant.value.split(".");
    expect(
      digits !== undefined &&
        fraction.length === digits &&
        currencyNumeric(c.merchant.currency as CurrencyCode) === Number(cs.currency) &&
        BigInt(`${whole}${fraction}`) === BigInt(cs.amount),
      "the conversion is not of the countersigned amount",
      ["/conversion/merchant", "/tee/countersign/amount", "/tee/countersign/currency"],
    );
    const reference = referenceProblem(c, committed);
    expect(reference === undefined, reference ?? "", ["/conversion/reference", "/fx_reference"]);
    const cap =
      (input.mandate.payload_sd as { fx?: { max_spread_bps?: number } }).fx?.max_spread_bps ??
      DEFAULT_MAX_SPREAD_BPS;
    expect(c.max_spread_bps === cap, "the conversion's cap is not the mandate's", [
      "/conversion/max_spread_bps",
      "/mandate/payload_sd/fx",
    ]);
    const problem = conversionProblem(c);
    expect(problem === undefined, problem ?? "", ["/conversion"]);
    return pass({
      merchant: `${c.merchant.currency} ${c.merchant.value}`,
      buyer: `${c.buyer.currency} ${c.buyer.value}`,
      rate: c.rate,
      reference: `${c.reference.rate} (${c.reference.provider}, ${c.reference.as_of})`,
      spread_bps: String(c.spread_bps),
      max_spread_bps: String(c.max_spread_bps),
    });
  },
};
