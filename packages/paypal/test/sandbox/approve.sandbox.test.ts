import { randomUUID } from "node:crypto";
import { CheckoutPaymentIntent, OrderStatus } from "@paypal/paypal-server-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { paypalConfig } from "../../src/config.js";
import { fromSdkError } from "../../src/errors.js";
import { createPayPal, type PayPal } from "../../src/sdk.js";
import { TokenCache } from "../../src/token.js";
import { approveOrder, experienceContext, payerActionUrl, usd } from "./approve.js";

const ORDER = 100n;

let paypal: PayPal;

beforeAll(() => {
  const cfg = paypalConfig();
  paypal = createPayPal(cfg, new TokenCache(cfg));
});

describe("buyer approval (sandbox)", () => {
  it("approves a $1 capture order as the sandbox buyer", async () => {
    const { result: order } = await paypal.orders
      .createOrder({
        paypalRequestId: randomUUID(),
        body: {
          intent: CheckoutPaymentIntent.Capture,
          purchaseUnits: [{ amount: usd(ORDER) }],
          paymentSource: { paypal: { experienceContext } },
        },
      })
      .catch((e) => Promise.reject(fromSdkError(e)));
    expect(order.status).toBe(OrderStatus.PayerActionRequired);

    await approveOrder(payerActionUrl(order));

    const { result } = await paypal.orders.getOrder({ id: order.id as string });
    expect(result.status).toBe(OrderStatus.Approved);
  });
});
