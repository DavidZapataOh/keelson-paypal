import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { sha256 } from "@keelson/core";
import { and, createQueries, eq, mandates, sql, transition } from "@keelson/db";
import {
  checkAuthorization,
  HoldMismatchError,
  holdOrderRequest,
  ids,
  PayPalError,
} from "@keelson/paypal";
import type { Context } from "hono";
import type { Deps } from "../app.ts";
import { voidAuthorization } from "../hold/maintenance.ts";
import {
  activateHold,
  expectedHold,
  holdable,
  type MandateRow,
  publishHold,
} from "../hold/state.ts";
import { fundingCapError } from "../hosted-caps.ts";
import { requireSession } from "../middleware/auth.ts";
import { call, type PayPalDeps, paypalProblem } from "../paypal.ts";
import type { Principal } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";

const AUTHORIZATION_LIFETIME_MS = 29 * 86_400_000;
/** Orders a buyer can still approve or Keelson can still authorize. */
const LIVE_ORDER = new Set(["CREATED", "SAVED", "PAYER_ACTION_REQUIRED", "APPROVED", "COMPLETED"]);

const problemContent = { "application/problem+json": { schema: ProblemSchema } };
const params = z.object({ id: z.string() });
const idempotencyKey = z.object({ "idempotency-key": z.string().min(1).max(255) });

const PayPalClient = z
  .object({
    clientId: z.string(),
    environment: z.enum(["sandbox", "production"]),
  })
  .openapi("PayPalClient");

const HoldOrder = z
  .object({ orderId: z.string(), state: z.literal("HOLD_PENDING") })
  .openapi("HoldOrder");

const AuthorizeHold = z
  .object({ orderId: z.string().min(1).max(64) })
  .openapi("AuthorizeHold", { description: "The order the buyer approved." });

const AuthorizedHold = z
  .object({
    state: z.literal("ACTIVE"),
    authorizationId: z.string(),
    expiresAt: z.iso.datetime().openapi({
      description: "When PayPal expires the authorization, 29 days after it was created.",
    }),
  })
  .openapi("AuthorizedHold");

const PendingHold = z
  .object({ state: z.literal("HOLD_PENDING"), authorizationId: z.string() })
  .openapi("PendingHold", {
    description: "PayPal holds the authorization for review; Keelson activates it once created.",
  });

const client = createRoute({
  method: "get",
  path: "/v1/paypal/client",
  operationId: "getPayPalClient",
  tags: ["paypal"],
  summary: "Get the PayPal client ID",
  description:
    "The client ID and environment the JavaScript SDK loads with. The client ID is public by design.",
  responses: {
    200: {
      description: "The PayPal client",
      content: { "application/json": { schema: PayPalClient } },
    },
    503: { description: "PayPal is not configured", content: problemContent },
  },
});

const hold = createRoute({
  method: "post",
  path: "/v1/mandates/{id}/hold",
  operationId: "holdMandate",
  tags: ["mandates"],
  summary: "Hold a mandate's budget",
  description:
    "Creates the PayPal `AUTHORIZE` order for the budget of a signed mandate, bound to the signed mandate hash by its `custom_id`, and moves the mandate to `HOLD_PENDING`. While the mandate waits for approval the same order is returned; an order PayPal no longer offers is replaced.",
  middleware: [requireSession()],
  request: { params, headers: idempotencyKey },
  responses: {
    200: {
      description: "The order the buyer approves",
      content: { "application/json": { schema: HoldOrder } },
    },
    401: { description: "Not signed in", content: problemContent },
    404: { description: "No such mandate for this user", content: problemContent },
    409: {
      description: "The mandate is not signed, or it holds each purchase separately",
      content: problemContent,
    },
    422: {
      description:
        "Keelson cannot capture for the mandate's merchant, PayPal refused, or the hold would pass the hosted operator's total cap (`hosted-cap`)",
      content: problemContent,
    },
    503: { description: "PayPal is unavailable", content: problemContent },
  },
});

const authorize = createRoute({
  method: "post",
  path: "/v1/mandates/{id}/hold/authorize",
  operationId: "authorizeMandateHold",
  tags: ["mandates"],
  summary: "Authorize an approved hold",
  description:
    "Authorizes the order stored for the mandate, checks the authorization against the signed mandate (amount, currency, `custom_id`, payee) and moves the mandate to `ACTIVE`. An authorization that does not match is voided.",
  middleware: [requireSession()],
  request: {
    params,
    headers: idempotencyKey,
    body: { required: true, content: { "application/json": { schema: AuthorizeHold } } },
  },
  responses: {
    200: {
      description: "The mandate is active",
      content: { "application/json": { schema: AuthorizedHold } },
    },
    202: {
      description: "PayPal holds the authorization as pending",
      content: { "application/json": { schema: PendingHold } },
    },
    401: { description: "Not signed in", content: problemContent },
    404: { description: "No such mandate for this user", content: problemContent },
    409: {
      description: "The mandate is not waiting for its hold, or the order is not its order",
      content: problemContent,
    },
    422: {
      description: "The authorization does not match the mandate, or PayPal refused",
      content: problemContent,
    },
    503: { description: "PayPal is unavailable", content: problemContent },
  },
});

function unavailable(c: Context) {
  return problem(c, 503, "paypal-unavailable", "PayPal unavailable", "PayPal is not configured.");
}

/** Where PayPal sends the buyer back: the mandate's page in the app. */
function returnUrl(appOrigin: string | undefined, id: string): string {
  if (appOrigin === undefined) throw new Error("appOrigin is required to hold mandates");
  return `${appOrigin}/mandates/${id}`;
}

/** The `PayPal-Request-Id` of the order that replaces `previous`; the same for concurrent replacements. */
function replacementRequestId(mandateHash: Buffer, previous: string): string {
  return ids.requestIdFromDigest(
    sha256(Buffer.concat([mandateHash, Buffer.from(previous, "utf8")])),
  );
}

function expiresAt(authorizedAt: Date | null): string {
  return new Date((authorizedAt?.getTime() ?? 0) + AUTHORIZATION_LIFETIME_MS).toISOString();
}

export function registerHold(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "kv" | "log" | "appOrigin" | "paypal" | "demoAgentId" | "hostedCaps">,
): void {
  const { db } = deps;
  const queries = createQueries(db);

  app.openapi(client, (c) => {
    if (!deps.paypal) return unavailable(c);
    c.header("cache-control", "public, max-age=3600");
    return c.json({ clientId: deps.paypal.clientId, environment: deps.paypal.environment }, 200);
  });

  const owned = async (c: Context, id: string): Promise<MandateRow | undefined> => {
    const row = await queries.mandateById(id);
    const userId = (c.get("principal") as Principal).subject;
    return row && row.userId === userId ? row : undefined;
  };

  const createOrder = async (paypal: PayPalDeps, row: MandateRow, requestId?: string) => {
    const url = returnUrl(deps.appOrigin, row.id);
    const order = holdOrderRequest({
      env: paypal.env,
      mid: row.id,
      mandateHash: row.mandateHash as Buffer,
      amount: expectedHold(paypal, row).amount,
      returnUrl: url,
      cancelUrl: url,
    });
    const created = await call(
      paypal.paypal.orders.createOrder({
        paypalRequestId: requestId ?? order.paypalRequestId,
        body: order.body,
      }),
    );
    if (!created.id) throw new Error("PayPal created an order without an id");
    return created.id;
  };

  app.openapi(hold, async (c) => {
    const { paypal } = deps;
    if (!paypal) return unavailable(c);
    const row = await owned(c, c.req.valid("param").id);
    if (!row) return problem(c, 404, "not-found", "Not found");
    if (row.holdMode === "per_purchase") {
      return problem(
        c,
        409,
        "per-purchase-mandate",
        "Per-purchase mandate",
        "This mandate holds each purchase separately.",
      );
    }
    const pending = (orderId: string) => c.json({ orderId, state: "HOLD_PENDING" as const }, 200);
    try {
      if (row.state === "SIGNED") {
        if (!holdable(paypal, row)) {
          return problem(
            c,
            422,
            "merchant-not-capturable",
            "Merchant not capturable",
            "The mandate allows no payee Keelson can hold its budget with.",
          );
        }
        const orderId = await createOrder(paypal, row);
        // Measured with the move, so concurrent holds cannot together pass the hosted total cap.
        const moved = await db.transaction(async (tx) => {
          const over = await fundingCapError(tx, deps, row.id, row.remainingMinor);
          if (over) return over;
          return transition(tx, "mandates", row.id, "SIGNED", "HOLD_PENDING", {
            paypalOrderId: orderId,
          });
        });
        if (typeof moved === "string") {
          return problem(c, 422, "hosted-cap", "Over the hosted operator's cap", moved);
        }
        if (moved) {
          await publishHold(deps, row, { state: "HOLD_PENDING", orderId });
          return pending(orderId);
        }
        // A concurrent request moved it first, with the same order: the request id is the same.
        const now = await queries.mandateById(row.id);
        if (now?.state === "HOLD_PENDING" && now.paypalOrderId) return pending(now.paypalOrderId);
      } else if (row.state === "HOLD_PENDING" && row.paypalOrderId) {
        const current = row.paypalOrderId;
        const status = await call(paypal.paypal.orders.getOrder({ id: current })).then(
          (order) => order.status as string | undefined,
          (err: unknown) => {
            if (err instanceof PayPalError && err.status === 404) return undefined;
            throw err;
          },
        );
        if (status !== undefined && LIVE_ORDER.has(status)) return pending(current);
        const orderId = await createOrder(
          paypal,
          row,
          replacementRequestId(row.mandateHash as Buffer, current),
        );
        const replaced = await db
          .update(mandates)
          .set({ paypalOrderId: orderId, paypalParentAuthorizationId: null, updatedAt: sql`now()` })
          .where(
            and(
              eq(mandates.id, row.id),
              eq(mandates.state, "HOLD_PENDING"),
              eq(mandates.paypalOrderId, current),
            ),
          );
        if (replaced.rowCount === 1) {
          await publishHold(deps, row, { state: "HOLD_PENDING", orderId });
        }
        const now = await queries.mandateById(row.id);
        if (now?.state === "HOLD_PENDING" && now.paypalOrderId) return pending(now.paypalOrderId);
      }
    } catch (err) {
      const answer = paypalProblem(c, err);
      if (answer) return answer;
      throw err;
    }
    return problem(
      c,
      409,
      "mandate-not-signed",
      "Mandate not signed",
      "Only a signed mandate waiting for its hold can be held.",
    );
  });

  app.openapi(authorize, async (c) => {
    const { paypal } = deps;
    if (!paypal) return unavailable(c);
    const row = await owned(c, c.req.valid("param").id);
    if (!row) return problem(c, 404, "not-found", "Not found");
    const { orderId } = c.req.valid("json");
    const active = (r: MandateRow) =>
      c.json(
        {
          state: "ACTIVE" as const,
          authorizationId: r.paypalParentAuthorizationId as string,
          expiresAt: expiresAt(r.authorizedAt),
        },
        200,
      );
    if (row.state === "ACTIVE" && row.paypalOrderId === orderId) return active(row);
    if (row.state !== "HOLD_PENDING") {
      return problem(
        c,
        409,
        "hold-not-pending",
        "Hold not pending",
        "The mandate is not waiting for its hold.",
      );
    }
    if (orderId !== row.paypalOrderId) {
      return problem(
        c,
        409,
        "order-mismatch",
        "Order mismatch",
        "The order is not the one held for this mandate.",
      );
    }

    try {
      const authorized = await call(
        paypal.paypal.orders.authorizeOrder({
          id: orderId,
          paypalRequestId: ids.operationRequestId(orderId, "authorize"),
        }),
      );
      const authorizationId =
        authorized.purchaseUnits?.[0]?.payments?.authorizations?.[0]?.id ?? undefined;
      if (!authorizationId) throw new Error(`PayPal authorized order ${orderId} without an id`);
      // The mandate moved on while PayPal authorized (revoked or expired): nothing may stay held.
      const lost = async () => {
        const now = await queries.mandateById(row.id);
        if (now?.state === "ACTIVE" && now.paypalParentAuthorizationId === authorizationId)
          return active(now);
        await voidAuthorization(paypal, authorizationId);
        return problem(
          c,
          409,
          "hold-not-pending",
          "Hold not pending",
          "The mandate left HOLD_PENDING while it was authorized; the authorization was voided.",
        );
      };
      const auth = await call(paypal.paypal.payments.getAuthorizedPayment({ authorizationId }));
      if (auth.status === "PENDING") {
        // Stored so that a void before activation finds it.
        const stored = await db
          .update(mandates)
          .set({ paypalParentAuthorizationId: authorizationId, updatedAt: sql`now()` })
          .where(
            and(
              eq(mandates.id, row.id),
              eq(mandates.state, "HOLD_PENDING"),
              eq(mandates.paypalOrderId, orderId),
            ),
          );
        if (stored.rowCount !== 1) return await lost();
        return c.json({ state: "HOLD_PENDING" as const, authorizationId }, 202);
      }
      let checked: ReturnType<typeof checkAuthorization>;
      try {
        checked = checkAuthorization(auth, expectedHold(paypal, row));
      } catch (err) {
        if (!(err instanceof HoldMismatchError)) throw err;
        deps.log.warn({ mandateId: row.id, authorizationId, field: err.field }, "hold mismatch");
        await voidAuthorization(paypal, authorizationId);
        return problem(
          c,
          422,
          "hold-mismatch",
          "Hold mismatch",
          `The authorization's ${err.field} does not match the mandate; it was voided.`,
          { field: err.field },
        );
      }
      if (!(await activateHold(deps, row, checked))) return await lost();
      return c.json(
        {
          state: "ACTIVE" as const,
          authorizationId: checked.authorizationId,
          expiresAt: expiresAt(checked.createTime),
        },
        200,
      );
    } catch (err) {
      const answer = paypalProblem(c, err);
      if (answer) return answer;
      throw err;
    }
  });
}
