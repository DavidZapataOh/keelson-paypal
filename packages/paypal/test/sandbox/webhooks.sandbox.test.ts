import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { paypalConfig } from "../../src/config.ts";
import { createPayPal, type PayPal } from "../../src/sdk.ts";
import { TokenCache } from "../../src/token.ts";
import {
  createWebhook,
  deleteWebhook,
  listWebhookEvents,
  listWebhooks,
} from "../../src/webhooks.ts";

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

describe("webhook events (sandbox)", () => {
  it("follows every page of the app's events", async () => {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 24 * 3600_000);
    const all = await listWebhookEvents(paypal.fetch, { startTime, endTime, pageSize: 100 });
    expect(all.length).toBeGreaterThan(2);
    const pageSize = Math.max(2, Math.ceil(all.length / 20));
    const paged = await listWebhookEvents(paypal.fetch, { startTime, endTime, pageSize });
    expect(new Set(paged.map((e) => e.id))).toEqual(new Set(all.map((e) => e.id)));
  });
});
