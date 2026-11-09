import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { type Db, eq, purchases, transition } from "@keelson/db";
import { markDelivered, type ShipmentCarrier } from "@keelson/paypal";
import type { Deps } from "../app.ts";
import { requireClient } from "../middleware/auth.ts";
import { call, paypalProblem } from "../paypal.ts";
import { ProblemSchema, problem } from "../problem.ts";

const Tracking = z
  .object({
    carrier: z
      .string()
      .regex(/^[A-Z0-9_]{2,64}$/)
      .openapi({ description: "PayPal's carrier code.", example: "USPS" }),
    tracking_number: z.string().min(1).max(64),
    delivered: z.boolean().default(false).openapi({
      description: "The carrier confirmed delivery; it becomes the dispute's delivery proof.",
    }),
  })
  .openapi("Tracking");

const problemContent = { "application/problem+json": { schema: ProblemSchema } };

const route = createRoute({
  method: "post",
  path: "/v1/purchases/{id}/tracking",
  tags: ["purchases"],
  summary: "Record a purchase's shipment and its delivery",
  description:
    "Adds the tracker to the PayPal order (Orders v2) and, once delivered, records the delivery with PayPal's Add Tracking API. Idempotent per tracking number.",
  middleware: [requireClient(["merchants:write"])],
  request: {
    params: z.object({ id: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/) }),
    headers: z.object({ "idempotency-key": z.string().min(1).max(255) }),
    body: { required: true, content: { "application/json": { schema: Tracking } } },
  },
  responses: {
    200: {
      description: "Recorded",
      content: {
        "application/json": {
          schema: z.object({ state: z.string(), tracker_id: z.string() }),
        },
      },
    },
    404: { description: "No such purchase", content: problemContent },
    409: { description: "The purchase was not captured", content: problemContent },
    422: { description: "PayPal refused", content: problemContent },
    503: { description: "PayPal unavailable", content: problemContent },
  },
});

async function purchaseOf(db: Db, id: string) {
  const [p] = await db
    .select({
      state: purchases.state,
      orderId: purchases.paypalOrderId,
      captureId: purchases.paypalCaptureId,
    })
    .from(purchases)
    .where(eq(purchases.id, id));
  return p;
}

export function registerPurchaseTracking(app: OpenAPIHono, deps: Pick<Deps, "db" | "paypal">) {
  app.openapi(route, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const p = await purchaseOf(deps.db, id);
    if (!p) return problem(c, 404, "not-found", "Not found", "No such purchase.");
    if (!p.orderId || !p.captureId || !["CAPTURED", "DELIVERED"].includes(p.state)) {
      return problem(c, 409, "not-captured", "Not captured", "Only a captured purchase ships.");
    }
    if (!deps.paypal) {
      return problem(c, 503, "paypal-unavailable", "PayPal unavailable", "PayPal is not set up.");
    }
    const { paypal } = deps.paypal;
    try {
      await call(
        paypal.orders.createOrderTracking({
          id: p.orderId,
          body: {
            captureId: p.captureId,
            trackingNumber: body.tracking_number,
            carrier: body.carrier as ShipmentCarrier,
            notifyPayer: false,
          },
        }),
      );
      if (body.delivered) {
        await markDelivered(paypal.fetch, {
          captureId: p.captureId,
          trackingNumber: body.tracking_number,
          carrier: body.carrier,
        });
        await transition(deps.db, "purchases", id, "CAPTURED", "DELIVERED");
      }
    } catch (err) {
      const answer = paypalProblem(c, err);
      if (answer) return answer;
      throw err;
    }
    const state = (await purchaseOf(deps.db, id))?.state ?? p.state;
    return c.json({ state, tracker_id: `${p.captureId}-${body.tracking_number}` }, 200);
  });
}
