import { randomUUID } from "node:crypto";
import { CheckoutPaymentIntent } from "@paypal/paypal-server-sdk";
import { paypalConfig } from "./src/config.ts";
import { createPayPal } from "./src/sdk.ts";
import { approveOrder, payerActionUrl } from "./src/testing.ts";
import { TokenCache } from "./src/token.ts";
import { experienceContext, usd } from "./test/sandbox/approve.ts";

const cfg = paypalConfig();
const pp = createPayPal(cfg, new TokenCache(cfg));
const invoiceId = `ks-dispute-test-${randomUUID().slice(0, 8)}`;
const { result: order } = await pp.orders.createOrder({
  paypalRequestId: randomUUID(),
  body: {
    intent: CheckoutPaymentIntent.Capture,
    purchaseUnits: [{ amount: usd(500n), invoiceId, description: "Trail running shoes, size 42" }],
    paymentSource: { paypal: { experienceContext } },
  },
});
await approveOrder(payerActionUrl(order));
const { result: cap } = await pp.orders.captureOrder({
  id: order.id as string,
  paypalRequestId: randomUUID(),
});
const c = cap.purchaseUnits?.[0]?.payments?.captures?.[0];
console.log("ORDER", order.id, "CAPTURE", c?.id, c?.status, "INVOICE", invoiceId);
