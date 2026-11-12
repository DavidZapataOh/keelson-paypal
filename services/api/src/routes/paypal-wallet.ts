import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { eq, paypalWallets } from "@keelson/db";
import {
  ids,
  PayPalError,
  savedWallet,
  walletPaymentTokenRequest,
  walletSetupTokenRequest,
} from "@keelson/paypal";
import type { Context } from "hono";
import type { Deps } from "../app.ts";
import { requireSession } from "../middleware/auth.ts";
import { call, paypalProblem } from "../paypal.ts";
import type { Principal } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";

/** A setup token is PayPal's for 3 days; the user who asked for it may save it for as long. */
const SETUP_TOKEN_TTL_S = 3 * 24 * 3600;
const setupKey = (token: string) => `paypal:setup:${token}`;

const problemContent = { "application/problem+json": { schema: ProblemSchema } };
const idempotencyKey = z.object({ "idempotency-key": z.string().min(1).max(255) });

const Wallet = z
  .object({
    email: z
      .string()
      .nullable()
      .openapi({ description: "The PayPal account, as PayPal names it." }),
    createdAt: z.iso.datetime(),
  })
  .openapi("PayPalWallet", {
    description: "The PayPal the user saved for holds under the mandates they sign.",
  });

const SetupToken = z
  .object({
    setupToken: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[0-9A-Za-z_-]+$/),
  })
  .openapi("PayPalSetupToken");

const common = {
  401: { description: "Not signed in", content: problemContent },
  503: { description: "PayPal is unavailable", content: problemContent },
};

const setup = createRoute({
  method: "post",
  path: "/v1/paypal/wallet/setup-token",
  operationId: "createPayPalSetupToken",
  tags: ["paypal"],
  summary: "Start saving PayPal",
  description:
    "Creates the PayPal Vault setup token the user approves in PayPal, for one merchant-initiated token billed on the terms of the mandates they sign.",
  middleware: [requireSession()],
  request: { headers: idempotencyKey },
  responses: {
    201: {
      description: "The setup token",
      content: { "application/json": { schema: SetupToken } },
    },
    422: { description: "PayPal refused", content: problemContent },
    ...common,
  },
});

const save = createRoute({
  method: "post",
  path: "/v1/paypal/wallet",
  operationId: "setPayPalWallet",
  tags: ["paypal"],
  summary: "Save PayPal",
  description:
    "Exchanges the setup token the user approved for a payment token and saves it as the user's PayPal for holds, in place of any saved before.",
  middleware: [requireSession()],
  request: {
    headers: idempotencyKey,
    body: { required: true, content: { "application/json": { schema: SetupToken } } },
  },
  responses: {
    201: { description: "Saved", content: { "application/json": { schema: Wallet } } },
    404: { description: "No such setup token of this user", content: problemContent },
    422: { description: "PayPal refused", content: problemContent },
    ...common,
  },
});

const read = createRoute({
  method: "get",
  path: "/v1/paypal/wallet",
  operationId: "getPayPalWallet",
  tags: ["paypal"],
  summary: "The saved PayPal",
  middleware: [requireSession()],
  responses: {
    200: { description: "The saved PayPal", content: { "application/json": { schema: Wallet } } },
    404: { description: "No saved PayPal", content: problemContent },
    ...common,
  },
});

const remove = createRoute({
  method: "delete",
  path: "/v1/paypal/wallet",
  operationId: "deletePayPalWallet",
  tags: ["paypal"],
  summary: "Remove the saved PayPal",
  description:
    "Deletes the payment token at PayPal and forgets it. Holds already authorized stay until they are captured, voided or expire; new holds need PayPal's approval again.",
  middleware: [requireSession()],
  responses: {
    204: { description: "Removed" },
    404: { description: "No saved PayPal", content: problemContent },
    422: { description: "PayPal refused", content: problemContent },
    ...common,
  },
});

const unavailable = (c: Context) =>
  problem(c, 503, "paypal-unavailable", "PayPal unavailable", "PayPal is not configured.");
const none = (c: Context) => problem(c, 404, "not-found", "Not found", "You have no saved PayPal.");
const wallet = (row: { email: string | null; createdAt: Date }) => ({
  email: row.email,
  createdAt: row.createdAt.toISOString(),
});

export function registerPayPalWallet(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "kv" | "appOrigin" | "paypal">,
): void {
  const { db, kv } = deps;
  const userOf = (c: Context) => (c.get("principal") as Principal).subject;
  const walletOf = async (userId: string) =>
    (await db.select().from(paypalWallets).where(eq(paypalWallets.userId, userId)))[0];

  app.openapi(setup, async (c) => {
    const { paypal } = deps;
    if (!paypal) return unavailable(c);
    if (deps.appOrigin === undefined) throw new Error("appOrigin is required to save PayPal");
    const userId = userOf(c);
    const back = `${deps.appOrigin}/passkeys`;
    const saved = await walletOf(userId);
    try {
      const token = await call(
        paypal.paypal.vault.createSetupToken({
          // Per user: two users may send the same Idempotency-Key.
          paypalRequestId: ids.operationRequestId(
            `${userId}:${c.req.valid("header")["idempotency-key"]}`,
            "setup-token",
          ),
          body: walletSetupTokenRequest({
            returnUrl: back,
            cancelUrl: back,
            ...(saved ? { customerId: saved.customerId } : {}),
          }),
        }),
      );
      if (!token.id) throw new Error("PayPal created a setup token without an id");
      await kv.set(setupKey(token.id), userId, { EX: SETUP_TOKEN_TTL_S });
      return c.json({ setupToken: token.id }, 201);
    } catch (err) {
      const answer = paypalProblem(c, err);
      if (answer) return answer;
      throw err;
    }
  });

  app.openapi(save, async (c) => {
    const { paypal } = deps;
    if (!paypal) return unavailable(c);
    const userId = userOf(c);
    const { setupToken } = c.req.valid("json");
    if ((await kv.get(setupKey(setupToken))) !== userId) {
      return problem(c, 404, "not-found", "Not found", "You have no such setup token.");
    }
    try {
      const token = await call(
        paypal.paypal.vault.createPaymentToken({
          paypalRequestId: ids.operationRequestId(setupToken, "payment-token"),
          body: walletPaymentTokenRequest(setupToken),
        }),
      );
      const { vaultId, customerId, email } = savedWallet(token);
      const previous = await walletOf(userId);
      const [row] = await db
        .insert(paypalWallets)
        .values({ userId, vaultId, customerId, email: email ?? null })
        .onConflictDoUpdate({
          target: paypalWallets.userId,
          set: { vaultId, customerId, email: email ?? null, createdAt: new Date() },
        })
        .returning();
      await kv.del(setupKey(setupToken));
      // One saved PayPal per user: the token it replaces is deleted at PayPal too.
      if (previous && previous.vaultId !== vaultId) await deleteToken(previous.vaultId);
      return c.json(wallet(row as typeof paypalWallets.$inferSelect), 201);
    } catch (err) {
      const answer = paypalProblem(c, err);
      if (answer) return answer;
      throw err;
    }
  });

  app.openapi(read, async (c) => {
    if (!deps.paypal) return unavailable(c);
    const row = await walletOf(userOf(c));
    return row ? c.json(wallet(row), 200) : none(c);
  });

  /** Deletes a payment token at PayPal; one PayPal no longer has is already deleted. */
  const deleteToken = async (vaultId: string) => {
    const paypal = deps.paypal;
    if (!paypal) return;
    try {
      await call(paypal.paypal.vault.deletePaymentToken(vaultId));
    } catch (err) {
      if (!(err instanceof PayPalError && err.status === 404)) throw err;
    }
  };

  app.openapi(remove, async (c) => {
    if (!deps.paypal) return unavailable(c);
    const userId = userOf(c);
    const row = await walletOf(userId);
    if (!row) return none(c);
    try {
      await deleteToken(row.vaultId);
    } catch (err) {
      const answer = paypalProblem(c, err);
      if (answer) return answer;
      throw err;
    }
    await db.delete(paypalWallets).where(eq(paypalWallets.userId, userId));
    return c.body(null, 204);
  });
}
