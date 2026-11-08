import type { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { Webhook } from "svix";
import type { Deps } from "../app.ts";
import { storeEvent } from "../channel3/webhook.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { problem } from "../problem.ts";

/**
 * Receives Channel3's offer events. Each delivery is verified with the endpoint's Svix secret
 * over `svix-id.svix-timestamp.body`, within five minutes, before the body is parsed. It sits
 * outside `/v1`: Channel3 authenticates with its signature, not with a client token.
 */
export function registerChannel3Webhook(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "kv" | "log" | "stamps" | "channel3WebhookSecret" | "rateLimit">,
): void {
  const webhook = deps.channel3WebhookSecret ? new Webhook(deps.channel3WebhookSecret) : null;
  app.post(
    "/webhooks/channel3",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => problem(c, 413, "payload-too-large", "Payload too large"),
    }),
    rateLimit(deps.kv, {
      name: "channel3-webhook",
      anonymousLimit: 600,
      trustProxy: deps.rateLimit?.trustProxy ?? false,
    }),
    async (c) => {
      if (!webhook) {
        return problem(
          c,
          503,
          "channel3-webhook-unconfigured",
          "Channel3 webhook unconfigured",
          "No Channel3 webhook secret is configured.",
        );
      }
      const body = Buffer.from(await c.req.arrayBuffer());
      const svixId = c.req.header("svix-id") ?? "";
      try {
        webhook.verify(body, {
          "svix-id": svixId,
          "svix-timestamp": c.req.header("svix-timestamp") ?? "",
          "svix-signature": c.req.header("svix-signature") ?? "",
        });
      } catch {
        return problem(
          c,
          400,
          "invalid-signature",
          "Invalid signature",
          "The delivery is not signed with the endpoint secret, or is too old.",
        );
      }
      let event: unknown;
      try {
        event = JSON.parse(body.toString("utf8"));
      } catch {
        event = null;
      }
      if (!(await storeEvent(deps, event, body, svixId))) {
        return problem(c, 400, "invalid-event", "Invalid event", "The body is not an offer event.");
      }
      return c.body(null, 204);
    },
  );
}
