import { z } from "zod";

export const webhook = z.looseObject({
  id: z.string(),
  url: z.string(),
  event_types: z.array(z.looseObject({ name: z.string() })),
});
export type Webhook = z.infer<typeof webhook>;

export const webhookList = z.looseObject({ webhooks: z.array(webhook).default([]) });

export const verifyWebhookSignatureResponse = z.looseObject({
  verification_status: z.enum(["SUCCESS", "FAILURE"]),
});
