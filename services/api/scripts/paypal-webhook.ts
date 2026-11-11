/**
 * Subscribes `https://api.keelson.finance/webhooks/paypal` to Keelson's PayPal events with the
 * app credentials in the environment: creates the webhook, or sets the event types of the one
 * that exists, and prints its id for `PAYPAL_WEBHOOK_ID`. Run by hand:
 * `node --env-file=../../.env scripts/paypal-webhook.ts`.
 */
import {
  createPayPal,
  createWebhook,
  listWebhooks,
  paypalConfig,
  TokenCache,
  updateWebhookEventTypes,
} from "@keelson/paypal";

/** The events Keelson's webhook subscribes to; each names a resource the worker re-reads. */
const PAYPAL_EVENT_TYPES = [
  "PAYMENT.AUTHORIZATION.CREATED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.REFUNDED",
  "CUSTOMER.DISPUTE.CREATED",
  "CUSTOMER.DISPUTE.UPDATED",
  "CUSTOMER.DISPUTE.RESOLVED",
  "VAULT.PAYMENT-TOKEN.DELETED",
] as const;

const URL = process.env.PAYPAL_WEBHOOK_URL ?? "https://api.keelson.finance/webhooks/paypal";

const cfg = paypalConfig();
const { fetch } = createPayPal(cfg, new TokenCache(cfg));
const types = [...PAYPAL_EVENT_TYPES];
const existing = (await listWebhooks(fetch)).find((w) => w.url === URL);
const same =
  existing !== undefined &&
  existing.event_types
    .map((e) => e.name)
    .sort()
    .join() === [...types].sort().join();
const webhook = !existing
  ? await createWebhook(fetch, URL, types)
  : same
    ? existing
    : await updateWebhookEventTypes(fetch, existing.id, types);
console.log(webhook.id);
