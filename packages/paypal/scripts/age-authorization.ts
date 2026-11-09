import { DST, hashObject, newId, toPayPalValue } from "@keelson/core";
import {
  createPayPal,
  fromSdkError,
  holdOrderRequest,
  ids,
  paypalConfig,
  TokenCache,
} from "../src/index.ts";
import { approveOrder, CANCEL_URL, payerActionUrl, RETURN_URL } from "../src/testing.ts";
import { usd } from "../test/sandbox/approve.ts";

const cfg = paypalConfig();
if (cfg.env !== "sandbox") throw new Error("age-authorization runs on the sandbox only");
const paypal = createPayPal(cfg, new TokenCache(cfg));

const HOLD = 2_000n;
const partialFlag = process.argv.indexOf("--partial");
const partial = partialFlag === -1 ? 0n : BigInt(process.argv[partialFlag + 1] ?? "");
if (partial < 0n || partial >= HOLD) throw new RangeError(`--partial must be below ${HOLD}`);

const mandateUlid = newId();
const digest = hashObject(DST.mandate, {
  mandate_id: mandateUlid,
  max: toPayPalValue({ currency: "USD", minor: HOLD }),
  currency: "USD",
});

try {
  const { result: order } = await paypal.orders.createOrder(
    holdOrderRequest({
      env: "s",
      mid: mandateUlid,
      mandateHash: digest,
      amount: { currency: "USD", minor: HOLD },
      returnUrl: RETURN_URL,
      cancelUrl: CANCEL_URL,
    }),
  );
  await approveOrder(payerActionUrl(order));
  const orderId = order.id as string;
  const { result } = await paypal.orders.authorizeOrder({
    id: orderId,
    paypalRequestId: ids.operationRequestId(orderId, "authorize"),
  });
  const authorizationId = result.purchaseUnits?.[0]?.payments?.authorizations?.[0]?.id;
  if (!authorizationId) throw new Error(`order ${orderId} returned no authorization`);
  if (partial > 0n) {
    const purchase = hashObject(DST.alibi, { nonce: newId() });
    await paypal.payments.captureAuthorizedPayment({
      authorizationId,
      paypalRequestId: ids.requestIdFromDigest(purchase),
      body: {
        amount: usd(partial),
        invoiceId: ids.encodeInvoiceId(mandateUlid, 1, purchase),
        finalCapture: false,
      },
    });
  }
  console.log(authorizationId);
} catch (e) {
  throw fromSdkError(e);
}
