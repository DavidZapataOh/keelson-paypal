import { DST, hashObject, newId, toPayPalValue } from "@keelson/core";
import { CheckoutPaymentIntent } from "@paypal/paypal-server-sdk";
import { createPayPal, fromSdkError, ids, paypalConfig, TokenCache } from "../../src/index.ts";
import {
  approveOrder,
  experienceContext,
  operationRequestId,
  payerActionUrl,
  usd,
} from "./approve.ts";

/** The `mid` of the demo mandate the engine's sandbox tests use. */
const MANDATE_ID = "01JBXG3K5N7Q9R2T4V6W8Y0Z1A";
const HOLD = 10_000n;
const CAPTURE = 6_000n;

const cfg = paypalConfig();
if (cfg.env !== "sandbox") throw new Error("authorization-states runs on the sandbox only");
const paypal = createPayPal(cfg, new TokenCache(cfg));

const digest = hashObject(DST.mandate, {
  mandate_id: MANDATE_ID,
  max: toPayPalValue({ currency: "USD", minor: HOLD }),
  currency: "USD",
});
const customId = ids.encodeCustomId({ env: "s", kind: "m", id: MANDATE_ID, digest });

/** A $100 hold on the demo mandate, approved by the sandbox buyer. */
async function authorize(): Promise<string> {
  const { result: order } = await paypal.orders.createOrder({
    paypalRequestId: ids.requestIdFromDigest(hashObject(DST.mandate, { nonce: newId() })),
    body: {
      intent: CheckoutPaymentIntent.Authorize,
      purchaseUnits: [
        {
          referenceId: MANDATE_ID,
          customId,
          description: `Agent purchase under Keelson mandate ${MANDATE_ID}`,
          amount: usd(HOLD),
        },
      ],
      paymentSource: { paypal: { experienceContext } },
    },
  });
  const orderId = order.id as string;
  await approveOrder(payerActionUrl(order));
  const { result } = await paypal.orders.authorizeOrder({
    id: orderId,
    paypalRequestId: operationRequestId(orderId, "authorize"),
  });
  const id = result.purchaseUnits?.[0]?.payments?.authorizations?.[0]?.id;
  if (!id) throw new Error(`order ${orderId} returned no authorization`);
  return id;
}

try {
  const created = await authorize();
  const captured = await authorize();
  await paypal.payments.captureAuthorizedPayment({
    authorizationId: captured,
    paypalRequestId: ids.requestIdFromDigest(hashObject(DST.mandate, { nonce: newId() })),
    body: { amount: usd(CAPTURE), finalCapture: false },
  });
  const voided = await authorize();
  await paypal.payments.voidPayment({
    authorizationId: voided,
    paypalRequestId: operationRequestId(voided, "void"),
  });
  console.log(
    [
      `PAYPAL_AUTHORIZATION_CREATED=${created}`,
      `PAYPAL_AUTHORIZATION_PARTIALLY_CAPTURED=${captured}`,
      `PAYPAL_AUTHORIZATION_VOIDED=${voided}`,
    ].join("\n"),
  );
} catch (e) {
  console.error(fromSdkError(e));
  process.exit(1);
}
