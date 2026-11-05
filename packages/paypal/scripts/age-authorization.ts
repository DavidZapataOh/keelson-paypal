import { randomUUID } from "node:crypto";
import { DST, hashObject, newId, toPayPalValue } from "@keelson/core";
import { CheckoutPaymentIntent } from "@paypal/paypal-server-sdk";
import { createPayPal, fromSdkError, ids, paypalConfig, TokenCache } from "../dist/index.js";
import { approveOrder, experienceContext, payerActionUrl } from "../test/sandbox/approve.ts";

const cfg = paypalConfig();
if (cfg.env !== "sandbox") throw new Error("age-authorization runs on the sandbox only");
const paypal = createPayPal(cfg, new TokenCache(cfg));

const mandateUlid = newId();
const digest = hashObject(DST.mandate, { mandate_id: mandateUlid, max: "20.00", currency: "USD" });

try {
  const { result: order } = await paypal.orders.createOrder({
    paypalRequestId: ids.requestIdFromDigest(digest),
    body: {
      intent: CheckoutPaymentIntent.Authorize,
      purchaseUnits: [
        {
          referenceId: mandateUlid,
          customId: ids.encodeCustomId({ env: "s", kind: "m", id: mandateUlid, digest }),
          description: `Agent purchase under Keelson mandate ${mandateUlid}; verify: verify.keelson.finance/a/${mandateUlid}`,
          amount: { currencyCode: "USD", value: toPayPalValue({ currency: "USD", minor: 2_000n }) },
        },
      ],
      paymentSource: { paypal: { experienceContext } },
    },
  });
  await approveOrder(payerActionUrl(order));
  const { result } = await paypal.orders.authorizeOrder({
    id: order.id as string,
    paypalRequestId: randomUUID(),
  });
  console.log(result.purchaseUnits?.[0]?.payments?.authorizations?.[0]?.id);
} catch (e) {
  throw fromSdkError(e);
}
