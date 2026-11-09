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

const link = z.looseObject({ href: z.string(), rel: z.string(), method: z.string().optional() });

/** A webhook event notification, as delivered and as listed. */
export const webhookEvent = z.looseObject({
  id: z.string(),
  create_time: z.string(),
  resource_type: z.string(),
  event_type: z.string(),
  resource: z
    .looseObject({ id: z.string().optional(), dispute_id: z.string().optional() })
    .refine((r) => r.id !== undefined || r.dispute_id !== undefined, "resource has no id"),
  links: z.array(link).default([]),
});
export type WebhookEvent = z.infer<typeof webhookEvent>;

/** `resource.id`, or `resource.dispute_id` for disputes. */
export const eventResourceId = (e: WebhookEvent): string =>
  (e.resource.id ?? e.resource.dispute_id) as string;

export const webhookEventList = z.looseObject({
  events: z.array(webhookEvent).default([]),
  links: z.array(link).default([]),
});

export const simulatedEvent = z.looseObject({ id: z.string(), event_type: z.string() });
