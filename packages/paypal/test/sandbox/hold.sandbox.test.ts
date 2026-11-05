import { randomBytes } from "node:crypto";
import { DST, hashObject, newId, toHex, toPayPalValue } from "@keelson/core";
import {
  type ApiResponse,
  AuthorizationStatus,
  CheckoutPaymentIntent,
} from "@paypal/paypal-server-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { paypalConfig } from "../../src/config.ts";
import { fromSdkError, PayPalError } from "../../src/errors.ts";
import {
  alibiDigest,
  encodeCustomId,
  encodeInvoiceId,
  encodeVerdictRef,
  requestIdFromDigest,
} from "../../src/ids.ts";
import { createPayPal, type PayPal } from "../../src/sdk.ts";
import { TokenCache } from "../../src/token.ts";
import {
  approveOrder,
  experienceContext,
  operationRequestId,
  payerActionUrl,
  usd,
} from "./approve.ts";

let paypal: PayPal;

beforeAll(() => {
  const cfg = paypalConfig();
  paypal = createPayPal(cfg, new TokenCache(cfg));
});

async function call<T>(label: string, p: Promise<ApiResponse<T>>): Promise<T> {
  const started = performance.now();
  const res = await p.catch((e) => Promise.reject(fromSdkError(e)));
  console.info(`${label}: ${Math.round(performance.now() - started)} ms`);
  return res.result;
}

const HOLD = 10_000n;
const CAPTURE_A = 4_000n;
const CAPTURE_B = 3_000n;
const dollars = (minor: bigint) => toPayPalValue({ currency: "USD", minor });

const hex = () => toHex(randomBytes(32));

describe("mandate hold (sandbox)", () => {
  it("authorizes $100, captures $40 and $30, voids the rest and refunds a capture", async () => {
    const mandateUlid = newId();
    const mandateDigest = hashObject(DST.mandate, {
      mandate_id: mandateUlid,
      max: dollars(HOLD),
      currency: "USD",
    });
    const customId = encodeCustomId({
      env: "s",
      kind: "m",
      id: mandateUlid,
      digest: mandateDigest,
    });
    expect(customId).toHaveLength(77);

    const order = await call(
      "create order",
      paypal.orders.createOrder({
        paypalRequestId: requestIdFromDigest(mandateDigest),
        body: {
          intent: CheckoutPaymentIntent.Authorize,
          purchaseUnits: [
            {
              referenceId: mandateUlid,
              customId,
              description: `Agent purchase under Keelson mandate ${mandateUlid}; verify: verify.keelson.finance/a/${mandateUlid}`,
              amount: usd(HOLD),
            },
          ],
          paymentSource: { paypal: { experienceContext } },
        },
      }),
    );
    const orderId = order.id as string;
    console.info(`order id: ${orderId}`);

    await approveOrder(payerActionUrl(order));

    const authorized = await call(
      "authorize",
      paypal.orders.authorizeOrder({
        id: orderId,
        paypalRequestId: operationRequestId(orderId, "authorize"),
      }),
    );
    const authorization = authorized.purchaseUnits?.[0]?.payments?.authorizations?.[0];
    const authorizationId = authorization?.id as string;
    const voidHold = () =>
      call(
        "void",
        paypal.payments.voidPayment({
          authorizationId,
          paypalRequestId: operationRequestId(orderId, "void"),
        }),
      );
    let open = true;
    try {
      expect(authorization?.status).toBe(AuthorizationStatus.Created);
      console.info(
        `authorization id: ${authorizationId}; custom_id in authorize response: ${authorization?.customId === customId}`,
      );

      const read = await call(
        "get authorization",
        paypal.payments.getAuthorizedPayment({ authorizationId }),
      );
      expect(read.customId).toBe(customId);
      const merchantId = read.payee?.merchantId as string;

      const purchase = (seq: number, minor: bigint) => {
        const alibiUlid = newId();
        const countersign = randomBytes(32);
        const digest = alibiDigest({
          mandateHash: toHex(mandateDigest),
          cartHash: hex(),
          policySetHash: hex(),
          countersignDigest: toHex(countersign),
          merchantId,
          amount: dollars(minor),
          currency: "USD",
          paypalOrderId: orderId,
        });
        return {
          minor,
          invoiceId: encodeInvoiceId(alibiUlid, seq, digest),
          requestId: requestIdFromDigest(countersign),
        };
      };
      const capture = (label: string, p: ReturnType<typeof purchase>) =>
        call(
          label,
          paypal.payments.captureAuthorizedPayment({
            authorizationId,
            paypalRequestId: p.requestId,
            body: { amount: usd(p.minor), invoiceId: p.invoiceId, finalCapture: false },
          }),
        );

      const a = purchase(1, CAPTURE_A);
      const captureA = await capture("capture A", a);
      const replayA = await capture("capture A replay", a);
      expect(replayA.id).toBe(captureA.id);

      const b = purchase(2, CAPTURE_B);
      const captureB = await capture("capture B", b);
      console.info(`capture ids: A ${captureA.id} B ${captureB.id}`);

      const [readA, readB] = await Promise.all([
        call(
          "get capture A",
          paypal.payments.getCapturedPayment({ captureId: captureA.id as string }),
        ),
        call(
          "get capture B",
          paypal.payments.getCapturedPayment({ captureId: captureB.id as string }),
        ),
      ]);
      expect(readA.invoiceId).toBe(a.invoiceId);
      expect(readB.invoiceId).toBe(b.invoiceId);

      await voidHold();
      open = false;
      const voided = await call(
        "get authorization",
        paypal.payments.getAuthorizedPayment({ authorizationId }),
      );
      expect(voided.status).toBe(AuthorizationStatus.Voided);

      const verdictUlid = newId();
      const verdictDigest = hashObject(DST.verdict, {
        verdict_id: verdictUlid,
        capture_id: captureA.id as string,
      });
      const verdictRef = encodeVerdictRef(verdictUlid, verdictDigest);
      expect(verdictRef).toHaveLength(48);
      const refund = await call(
        "refund A",
        paypal.payments.refundCapturedPayment({
          captureId: captureA.id as string,
          paypalRequestId: requestIdFromDigest(verdictDigest),
          body: { amount: usd(CAPTURE_A), customId: verdictRef },
        }),
      );
      const readRefund = await call(
        "get refund",
        paypal.payments.getRefund({ refundId: refund.id as string }),
      );
      expect(readRefund.customId).toBe(verdictRef);
    } finally {
      // A failed run must not leave the hold open on the sandbox buyer.
      if (open) {
        await voidHold().catch((e: unknown) => {
          console.info(`cleanup void failed: ${e instanceof PayPalError ? e.name : String(e)}`);
        });
      }
    }
  });
});
