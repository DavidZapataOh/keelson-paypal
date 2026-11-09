import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { merchantSettlement, sql } from "@keelson/db";
import type { Deps } from "../app.ts";
import { MERCHANTS } from "../merchants.ts";
import { requireClient } from "../middleware/auth.ts";
import { ProblemSchema, problem } from "../problem.ts";

const Receiver = z.union([z.email(), z.string().regex(/^[A-Z0-9]{13}$/)]).openapi({
  description: "The PayPal account paid: an email address or a PayPal account id.",
});

const SettlementPreference = z
  .object({
    rail: z.enum(["pyusd", "paypal"]).openapi({
      description:
        "`pyusd`: slashes and warranties pay the merchant in PYUSD on chain. `paypal`: they pay Keelson's treasury, and Keelson sends the merchant a PayPal Payout in USD.",
    }),
    paypal_receiver: Receiver.optional(),
  })
  .refine((b) => b.rail === "pyusd" || b.paypal_receiver !== undefined, {
    message: "the paypal rail needs a paypal_receiver",
    path: ["paypal_receiver"],
  })
  .openapi("SettlementPreference");

const route = createRoute({
  method: "put",
  path: "/v1/merchants/{merchantId}/settlement",
  tags: ["merchants"],
  summary: "Choose how a merchant is paid when a dispute goes its way",
  description:
    "Applies to verdicts signed afterwards: the rail decides the payee the TEE legs sign into the `Verdict`.",
  middleware: [requireClient(["merchants:write"])],
  request: {
    params: z.object({ merchantId: z.string().min(1).max(64) }),
    body: { required: true, content: { "application/json": { schema: SettlementPreference } } },
  },
  responses: {
    200: {
      description: "Stored",
      content: { "application/json": { schema: SettlementPreference } },
    },
    404: {
      description: "No such merchant",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export function registerMerchantsSettlement(app: OpenAPIHono, deps: Pick<Deps, "db">): void {
  app.openapi(route, async (c) => {
    const { merchantId } = c.req.valid("param");
    if (!MERCHANTS.some((m) => m.id === merchantId)) {
      return problem(c, 404, "not-found", "Not found", "No such merchant.");
    }
    const body = c.req.valid("json");
    const paypalReceiver = body.rail === "paypal" ? (body.paypal_receiver ?? null) : null;
    await deps.db
      .insert(merchantSettlement)
      .values({ merchantId, rail: body.rail, paypalReceiver })
      .onConflictDoUpdate({
        target: merchantSettlement.merchantId,
        set: { rail: body.rail, paypalReceiver, updatedAt: sql`now()` },
      });
    return c.json(
      { rail: body.rail, ...(paypalReceiver ? { paypal_receiver: paypalReceiver } : {}) },
      200,
    );
  });
}
