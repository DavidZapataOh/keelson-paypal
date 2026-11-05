import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { paypalConfig } from "../../src/config.ts";
import { createPayPal, type PayPal } from "../../src/sdk.ts";
import { TokenCache } from "../../src/token.ts";
import { createWebhook, deleteWebhook, listWebhooks } from "../../src/webhooks.ts";

const URL = "https://api.keelson.finance/webhooks/paypal";
const EVENT_TYPES = [
  "PAYMENT.AUTHORIZATION.CREATED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.REFUNDED",
  "CUSTOMER.DISPUTE.CREATED",
  "CUSTOMER.DISPUTE.UPDATED",
  "CUSTOMER.DISPUTE.RESOLVED",
];

let paypal: PayPal;
let createdId: string | undefined;

beforeAll(() => {
  const cfg = paypalConfig();
  paypal = createPayPal(cfg, new TokenCache(cfg));
});

afterAll(async () => {
  if (createdId) await deleteWebhook(paypal.fetch, createdId);
});

describe("webhooks (sandbox)", () => {
  it("creates, lists and deletes a webhook", async () => {
    for (const stale of (await listWebhooks(paypal.fetch)).filter((w) => w.url === URL)) {
      await deleteWebhook(paypal.fetch, stale.id);
    }

    const created = await createWebhook(paypal.fetch, URL, EVENT_TYPES);
    createdId = created.id;
    expect(created.event_types.map((e) => e.name).sort()).toEqual([...EVENT_TYPES].sort());

    const listed = await listWebhooks(paypal.fetch);
    expect(listed.map((w) => w.id)).toContain(created.id);

    await deleteWebhook(paypal.fetch, created.id);
    createdId = undefined;
    expect((await listWebhooks(paypal.fetch)).map((w) => w.id)).not.toContain(created.id);
  });
});
