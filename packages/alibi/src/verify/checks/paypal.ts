import { alibiDigest, type CurrencyCode, fromHex, toHex } from "@keelson/core";
import { paypalRefCommit } from "@keelson/log";
import { parseCustomId, parseInvoiceId, purchaseHoldDigest } from "@keelson/paypal/ids";
import { type CheckDef, expect, pass } from "../check.ts";
import { b64urlOfHex, isBundle, UNDISCLOSED } from "./util.ts";

const ENV: Readonly<Record<number, "s" | "p">> = { 421614: "s", 42161: "p" };

/**
 * The leaf's PayPal commitment opens to these ids, the hold's `custom_id` names this mandate or
 * this request, and the invoice id names this alibi with the digest of what was captured.
 */
export const paypal: CheckDef = {
  id: "paypal.ids",
  step: 0,
  reads: ["/paypal"],
  run(input) {
    if (!isBundle(input)) return UNDISCLOSED;
    const p = input.paypal;
    const c = input.tee.countersign;
    const ctx = input.eval.context;
    expect(
      b64urlOfHex(paypalRefCommit(fromHex(p.ref_salt), p.order_id, p.authorization_id)) ===
        input.leaf_view.paypal_ref_commit,
      "paypal_ref_commit",
      [
        "/paypal/ref_salt",
        "/paypal/order_id",
        "/paypal/authorization_id",
        "/leaf_view/paypal_ref_commit",
      ],
    );
    const amount = { currency: ctx.currency as CurrencyCode, minor: BigInt(c.amount) };
    const custom = parseCustomId(p.custom_id);
    expect(custom !== null && custom.env === ENV[input.tee.domain.chain_id], "custom_id", [
      "/paypal/custom_id",
    ]);
    const digest =
      custom.kind === "m"
        ? c.mandateHash
        : toHex(
            purchaseHoldDigest({
              mandateHash: fromHex(c.mandateHash),
              cartHash: fromHex(c.cartHash),
              merchantId: String(ctx.merchant),
              amount,
            }),
          );
    expect(
      (custom.kind === "m" || custom.id === input.alibi_id) && toHex(custom.digest) === digest,
      "custom_id names another mandate or request",
      ["/paypal/custom_id"],
    );
    if (p.invoice_id !== undefined) {
      const inv = parseInvoiceId(p.invoice_id);
      expect(inv?.id === input.alibi_id, "the invoice id names another alibi", [
        "/paypal/invoice_id",
      ]);
      expect(p.merchant_id, "the invoice id's merchant is not given", ["/paypal/merchant_id"]);
      const want = alibiDigest({
        mandateHash: c.mandateHash as `0x${string}`,
        cartHash: c.cartHash as `0x${string}`,
        policySetHash: c.policySetHash as `0x${string}`,
        countersignDigest: input.tee.digest as `0x${string}`,
        merchantId: p.merchant_id,
        amount,
        paypalOrderId: p.order_id,
      }).subarray(0, 16);
      expect(toHex(inv.digest16) === toHex(want), "digest", [
        "/paypal/invoice_id",
        "/paypal/merchant_id",
      ]);
    }
    return pass();
  },
};
