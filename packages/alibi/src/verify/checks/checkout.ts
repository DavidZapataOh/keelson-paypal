import {
  type Cart,
  type CurrencyCode,
  currencyNumeric,
  fromPayPalAmount,
  type Json,
  jcs,
  sha256,
  toHex,
} from "@keelson/core";
import { type CheckDef, expect, pass } from "../check.ts";
import { isBundle, UNDISCLOSED } from "./util.ts";

/**
 * The checkout total the countersign names, with its breakdown: the disclosed `api.checkout`
 * item is the PayPal amount the legs evaluated, the evidence root binds it, its items are the
 * disclosed cart's, its parts add up to its value, and that value and currency are the
 * countersign's `amount` and `currency`. How the total splits into tax and shipping is the agent's
 * reading of the store's checkout, checked here for its arithmetic only. An `api.checkout` item
 * the manifest holds but the Alibi leaves out, or one disclosed without its cart, is undisclosed;
 * a purchase countersigned before the item existed has none.
 */
export const checkout: CheckDef = {
  id: "evidence.checkout",
  step: 0,
  reads: ["/checkout", "/cart", "/tee/countersign/amount", "/tee/countersign/currency"],
  run(input) {
    if (!isBundle(input)) return UNDISCLOSED;
    const amount = input.checkout;
    if (amount === undefined) {
      return input.manifest.public.items.some((x) => x.type === "api.checkout")
        ? { status: "undisclosed", reads: ["/checkout", "/manifest/public/items"] }
        : { status: "absent", reads: ["/checkout"] };
    }
    if (input.cart === undefined) return { status: "undisclosed", reads: ["/cart"] };
    const i = input.manifest.disclosures.findIndex((d) => d.type === "api.checkout");
    expect(
      toHex(sha256(new TextEncoder().encode(jcs(amount as Json)))) ===
        input.manifest.disclosures[i]?.content_hash,
      "the checkout amount is not the disclosed item",
      ["/checkout", `/manifest/disclosures/${i}/content_hash`],
    );
    let total: ReturnType<typeof fromPayPalAmount> | undefined;
    let why = "";
    try {
      total = fromPayPalAmount(amount, input.cart as unknown as Cart | undefined);
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
    }
    expect(total, `the checkout amount does not reconcile: ${why}`, ["/checkout", "/cart"]);
    const c = input.tee.countersign;
    expect(String(total.minor) === c.amount, "the checkout total is not the countersigned amount", [
      "/checkout/value",
      "/tee/countersign/amount",
    ]);
    expect(
      currencyNumeric(total.currency as CurrencyCode) === Number(c.currency),
      "the checkout currency is not the countersigned one",
      ["/checkout/currency_code", "/tee/countersign/currency"],
    );
    return pass({
      currency: total.currency,
      items: String(total.items),
      tax: String(total.tax),
      shipping: String(total.shipping),
      discount: String(total.discount),
      total: String(total.minor),
    });
  },
};
