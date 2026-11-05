import { DST, hashObject, newId, toPayPalValue } from "@keelson/core";
import { CheckoutPaymentIntent } from "@paypal/paypal-server-sdk";
import { createPayPal, fromSdkError, ids, paypalConfig, TokenCache } from "../dist/index.js";
import {
  approveOrder,
  experienceContext,
  operationRequestId,
  payerActionUrl,
  usd,
} from "../test/sandbox/approve.ts";

const cfg = paypalConfig();
if (cfg.env !== "sandbox") throw new Error("age-authorization runs on the sandbox only");
const paypal = createPayPal(cfg, new TokenCache(cfg));

const HOLD = 2_000n;

const mandateUlid = newId();
const digest = hashObject(DST.mandate, {
  mandate_id: mandateUlid,
  max: toPayPalValue({ currency: "USD", minor: HOLD }),
  currency: "USD",
});

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
          amount: usd(HOLD),
        },
      ],
      paymentSource: { paypal: { experienceContext } },
    },
  });
  await approveOrder(payerActionUrl(order));
  const orderId = order.id as string;
  const { result } = await paypal.orders.authorizeOrder({
    id: orderId,
    paypalRequestId: operationRequestId(orderId, "authorize"),
  });
  const authorizationId = result.purchaseUnits?.[0]?.payments?.authorizations?.[0]?.id;
  if (!authorizationId) throw new Error(`order ${orderId} returned no authorization`);
  console.log(authorizationId);
} catch (e) {
  throw fromSdkError(e);
}
