import type { OpenAPIHono } from "@hono/zod-openapi";
import { deliveryHeaders, verifyWebhookDelivery, WebhookVerificationError } from "@keelson/paypal";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Deps } from "../app.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { storeDelivery } from "../paypal/webhook.ts";
import { problem } from "../problem.ts";
import { span } from "../tracing.ts";

/**
 * Receives PayPal's webhook deliveries. Each one is verified against PayPal's signature over its
 * exact bytes before it is parsed, stored once per event, and acknowledged without calling
 * PayPal: the worker re-reads the resource and applies what PayPal says, never the body. It sits
 * outside `/v1`: PayPal authenticates with its signature, not with a client token.
 */
export function registerPayPalWebhook(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "kv" | "log" | "paypalWebhook" | "paypalEvents" | "rateLimit">,
): void {
  app.post(
    "/webhooks/paypal",
    bodyLimit({
      maxSize: 512 * 1024,
      onError: (c) => problem(c, 413, "payload-too-large", "Payload too large"),
    }),
    rateLimit(deps.kv, {
      name: "paypal-webhook",
      anonymousLimit: 600,
      trustProxy: deps.rateLimit?.trustProxy ?? false,
    }),
    (c) => span("webhook.ack", {}, () => receive(c)),
  );

  async function receive(c: Context) {
    const config = deps.paypalWebhook;
    if (!config) {
      return problem(
        c,
        503,
        "paypal-webhook-unconfigured",
        "PayPal webhook unconfigured",
        "No PayPal webhook id is configured.",
      );
    }
    const body = new Uint8Array(await c.req.arrayBuffer());
    try {
      const headers = deliveryHeaders(c.req.raw.headers);
      const verified = await verifyWebhookDelivery({
        headers,
        body,
        webhookId: config.webhookId,
        certs: config.certs,
        now: config.now?.() ?? new Date(),
      });
      if (await storeDelivery(deps, verified, body, headers)) {
        deps.paypalEvents?.wake();
        deps.log.info(
          { eventId: verified.eventId, eventType: verified.eventType },
          "paypal event stored",
        );
      }
      return c.body(null, 200);
    } catch (err) {
      if (!(err instanceof WebhookVerificationError)) throw err;
      deps.log.warn({ code: err.code, reason: err.message }, "paypal delivery refused");
      return problem(
        c,
        400,
        "invalid-signature",
        "Invalid signature",
        "The delivery is not signed by PayPal for this webhook, or is too old.",
        { code: err.code },
      );
    }
  }
}
