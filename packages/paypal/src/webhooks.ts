import type { PayPalFetch } from "./rest.ts";
import {
  simulatedEvent,
  verifyWebhookSignatureResponse,
  type Webhook,
  type WebhookEvent,
  webhook,
  webhookEvent,
  webhookEventList,
  webhookList,
} from "./schemas/webhooks.ts";

const webhookPath = (id: string) => `/v1/notifications/webhooks/${encodeURIComponent(id)}`;

export async function createWebhook(
  f: PayPalFetch,
  url: string,
  eventTypes: string[],
): Promise<Webhook> {
  const res = await f<unknown>("POST", "/v1/notifications/webhooks", {
    body: { url, event_types: eventTypes.map((name) => ({ name })) },
  });
  return webhook.parse(res);
}

export async function listWebhooks(f: PayPalFetch): Promise<Webhook[]> {
  const res = await f<unknown>("GET", "/v1/notifications/webhooks");
  return webhookList.parse(res).webhooks;
}

/** Replaces the webhook's event types; PayPal supports only `replace` on `/event_types`. */
export async function updateWebhookEventTypes(
  f: PayPalFetch,
  id: string,
  eventTypes: string[],
): Promise<Webhook> {
  const res = await f<unknown>("PATCH", webhookPath(id), {
    body: [{ op: "replace", path: "/event_types", value: eventTypes.map((name) => ({ name })) }],
  });
  return webhook.parse(res);
}

export async function deleteWebhook(f: PayPalFetch, id: string): Promise<void> {
  await f<void>("DELETE", webhookPath(id));
}

export interface WebhookEventQuery {
  /** RFC 3339. */
  startTime: string;
  endTime: string;
  pageSize?: number;
  eventType?: string;
  transactionId?: string;
}

/** The app's events in a time range, following `links[rel=next]` to the last page. */
export async function listWebhookEvents(
  f: PayPalFetch,
  q: WebhookEventQuery,
): Promise<WebhookEvent[]> {
  const query: Record<string, string> = {
    start_time: q.startTime,
    end_time: q.endTime,
    page_size: String(q.pageSize ?? 100),
  };
  if (q.eventType) query.event_type = q.eventType;
  if (q.transactionId) query.transaction_id = q.transactionId;
  const events: WebhookEvent[] = [];
  let page = webhookEventList.parse(
    await f<unknown>("GET", "/v1/notifications/webhooks-events", { query }),
  );
  for (;;) {
    events.push(...page.events);
    const next = page.links.find((l) => l.rel === "next")?.href;
    if (!next) return events;
    const url = new URL(next);
    if (url.pathname !== "/v1/notifications/webhooks-events") {
      throw new Error(`unexpected next link ${url.pathname}`);
    }
    page = webhookEventList.parse(
      await f<unknown>("GET", url.pathname, { query: Object.fromEntries(url.searchParams) }),
    );
  }
}

export async function getWebhookEvent(f: PayPalFetch, id: string): Promise<WebhookEvent> {
  return webhookEvent.parse(
    await f<unknown>("GET", `/v1/notifications/webhooks-events/${encodeURIComponent(id)}`),
  );
}

/** Delivers the event again, under a new transmission id, to the given webhooks. */
export async function resendWebhookEvent(
  f: PayPalFetch,
  eventId: string,
  webhookIds: string[],
): Promise<void> {
  await f<unknown>(
    "POST",
    `/v1/notifications/webhooks-events/${encodeURIComponent(eventId)}/resend`,
    {
      body: { webhook_ids: webhookIds },
    },
  );
}

/**
 * Sends a mock event to a webhook or a URL. PayPal signs mock events for the webhook id
 * `WEBHOOK_ID`, whichever target is named.
 */
export async function simulateWebhookEvent(
  f: PayPalFetch,
  input: { webhookId?: string; url?: string; eventType: string; resourceVersion?: string },
): Promise<{ id: string; event_type: string }> {
  const body: Record<string, string> = { event_type: input.eventType };
  if (input.webhookId) body.webhook_id = input.webhookId;
  if (input.url) body.url = input.url;
  if (input.resourceVersion) body.resource_version = input.resourceVersion;
  return simulatedEvent.parse(
    await f<unknown>("POST", "/v1/notifications/simulate-event", { body }),
  );
}

export interface VerifyWebhookSignatureInput {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
  webhookId: string;
  webhookEvent: unknown;
}

/** PayPal's postback check; it is not supported for mock events. */
export async function verifyWebhookSignature(
  f: PayPalFetch,
  input: VerifyWebhookSignatureInput,
): Promise<"SUCCESS" | "FAILURE"> {
  const res = await f<unknown>("POST", "/v1/notifications/verify-webhook-signature", {
    body: {
      auth_algo: input.authAlgo,
      cert_url: input.certUrl,
      transmission_id: input.transmissionId,
      transmission_sig: input.transmissionSig,
      transmission_time: input.transmissionTime,
      webhook_id: input.webhookId,
      webhook_event: input.webhookEvent,
    },
  });
  return verifyWebhookSignatureResponse.parse(res).verification_status;
}
