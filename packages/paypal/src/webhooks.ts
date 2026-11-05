import type { PayPalFetch } from "./rest.js";
import {
  verifyWebhookSignatureResponse,
  type Webhook,
  webhook,
  webhookList,
} from "./schemas/webhooks.js";

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

export async function deleteWebhook(f: PayPalFetch, id: string): Promise<void> {
  await f<void>("DELETE", `/v1/notifications/webhooks/${encodeURIComponent(id)}`);
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
