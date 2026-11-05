import { randomUUID } from "node:crypto";
import { AuthorizationStatus } from "@paypal/paypal-server-sdk";
import { describe, expect, it } from "vitest";
import { paypalConfig } from "../../src/config.js";
import { fromSdkError } from "../../src/errors.js";
import { createPayPal } from "../../src/sdk.js";
import { TokenCache } from "../../src/token.js";

const MIN_AGE_DAYS = 4;
const DAY_MS = 86_400_000;

const cfg = paypalConfig();
const paypal = createPayPal(cfg, new TokenCache(cfg));
const authorizationId = process.env.PAYPAL_AGED_AUTHORIZATION_ID;

const aged = authorizationId
  ? await paypal.payments
      .getAuthorizedPayment({ authorizationId })
      .then((r) => r.result)
      .catch((e) => Promise.reject(fromSdkError(e)))
  : undefined;
const ageDays = aged?.createTime
  ? Math.floor((Date.now() - Date.parse(aged.createTime)) / DAY_MS)
  : 0;

const skipReason = !authorizationId
  ? "skipped: PAYPAL_AGED_AUTHORIZATION_ID is not set"
  : ageDays < MIN_AGE_DAYS
    ? `skipped: authorization is ${ageDays} days old`
    : undefined;

describe("reauthorize (sandbox)", () => {
  it.skipIf(skipReason !== undefined)(
    skipReason ?? `reauthorizes a ${ageDays}-day-old authorization`,
    async () => {
      const res = await paypal.payments
        .reauthorizePayment({
          authorizationId: authorizationId as string,
          paypalRequestId: randomUUID(),
        })
        .catch((e) => Promise.reject(fromSdkError(e)));
      expect(res.result.id).toBeTruthy();
      expect(res.result.id).not.toBe(authorizationId);
      expect(res.result.status).toBe(AuthorizationStatus.Created);
    },
  );
});
