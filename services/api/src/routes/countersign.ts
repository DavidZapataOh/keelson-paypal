import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { type Cart, cartHash, isUlid } from "@keelson/core";
import { type Db, purchases, transition } from "@keelson/db";
import { hexToBytes } from "viem";
import type { Deps } from "../app.ts";
import { requireClient } from "../middleware/auth.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { LegError } from "../tee/client.ts";
import { VERIFYING_CONTRACT } from "../tee/config.ts";
import { CoordinatorError, countersign2of2 } from "../tee/coordinator.ts";

const Hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const Hex = (bytes: number) => z.string().regex(new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`));

const CartSchema = z
  .object({
    merchant: z.string(),
    currency: z.string().length(3),
    lines: z
      .array(
        z.object({
          sku: z.string(),
          size: z.string().nullable().optional(),
          color: z.string().nullable().optional(),
          category: z.string(),
          qty: z.number().int().positive(),
          unit_minor: z.number().int().nonnegative(),
        }),
      )
      .min(1)
      .max(64),
    return_days: z.number().int().nonnegative(),
    returns_free: z.boolean(),
  })
  .openapi("Cart");

const Body = z
  .object({
    authorizationId: z.string().min(1).max(64).openapi({
      description: "The PayPal authorization that holds the mandate's funds; leg A reads it.",
    }),
    closedMandate: z.string().min(1).max(131_072).openapi({
      description: "The open mandate closed by the agent's key binding over the request and cart.",
    }),
    cart: CartSchema,
    unit: z.record(z.string(), z.unknown()).openapi({
      description: "The PayPal purchase unit the cart is checked against.",
    }),
    evidence: z.record(z.string(), z.array(z.string())).default({}),
    evidenceRoot: Hex32,
  })
  .openapi("CountersignRequest");

const CountersignMessage = z
  .record(z.string(), z.string())
  .openapi({ description: "The EIP-712 `Countersign` message, as decimal strings." });

const Result = z
  .object({
    purchaseId: z.string(),
    mode: z.enum(["2of2", "degraded"]).openapi({
      description: "`degraded` when leg B was unreachable and only leg A signed.",
    }),
    decision: z.enum(["allow", "deny"]),
    countersign: CountersignMessage,
    digest: Hex32,
    signatures: z.object({ tdx: Hex(65), nitro: Hex(65).nullable() }),
    signers: z.object({ tdx: z.string(), nitro: z.string().nullable() }),
    trace: z
      .unknown()
      .openapi({ description: "The `keelson.eval/1` trace both legs signed over." }),
  })
  .openapi("Countersigned");

const problemContent = { "application/problem+json": { schema: ProblemSchema } };

const route = createRoute({
  method: "post",
  path: "/v1/countersign",
  tags: ["tee"],
  summary: "Countersign a cart",
  description:
    "Sends the cart to the TEE legs in order and returns the countersignatures only when both agree. A DENY is countersigned too.",
  middleware: [requireClient(["countersign:write"])],
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(255) }),
    body: { required: true, content: { "application/json": { schema: Body } } },
  },
  responses: {
    200: {
      description: "The decision and its countersignatures",
      content: { "application/json": { schema: Result } },
    },
    401: { description: "A leg refused the agent's authority", content: problemContent },
    409: {
      description: "The mandate is not active, or the request was already used",
      content: problemContent,
    },
    404: { description: "No such mandate", content: problemContent },
    413: { description: "A leg refused the request as too large", content: problemContent },
    422: { description: "The request is invalid", content: problemContent },
    429: { description: "Too many countersigns for this mandate", content: problemContent },
    502: {
      description: "The legs disagree, or a signer is not registered",
      content: problemContent,
    },
    503: { description: "A leg needed to sign is unavailable", content: problemContent },
  },
});

const RATE_PER_MANDATE = 60;
const RATE_WINDOW_SEC = 60;
const USABLE = new Set(["SIGNED", "HOLD_PENDING", "ACTIVE"]);

const b64json = (segment: string | undefined): unknown => {
  if (!segment) throw new Error("empty segment");
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
};

/**
 * The request ULID the agent signed and the mandate id, read from a closed mandate. They only
 * select records here; the legs verify the whole credential.
 */
function readClosedMandate(token: string): { requestId: string; mid: string } {
  const parts = token.split("~");
  const kb = parts[parts.length - 1]?.split(".")[1];
  const nonce = (b64json(kb) as { nonce?: unknown }).nonce;
  if (typeof nonce !== "string" || !isUlid(nonce))
    throw new Error("the key binding has no request id");
  for (const disclosure of parts.slice(1)) {
    if (!disclosure) continue;
    let value: unknown;
    try {
      value = (b64json(disclosure) as unknown[]).at(-1);
    } catch {
      continue;
    }
    const m = value as { v?: unknown; mid?: unknown } | null;
    if (m?.v === "keelson.mandate.1" && typeof m.mid === "string")
      return { requestId: nonce, mid: m.mid };
  }
  throw new Error("the mandate names no id");
}

/** The problem status for a refusal a leg itself gave. */
function legStatus(
  code: string | undefined,
  status: number | undefined,
): 401 | 409 | 413 | 422 | 502 {
  if (code?.startsWith("auth.")) return 401;
  if (status === 409 || status === 413 || status === 422) return status;
  return 502;
}

async function failPurchase(db: Db, id: string, reason: string): Promise<void> {
  await transition(db, "purchases", id, "EVALUATING", "FAILED", { failureReason: reason });
}

export function registerCountersign(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "kv" | "log" | "tee">,
): void {
  const { db, kv, log, tee } = deps;

  app.openapi(route, async (c) => {
    const body = c.req.valid("json");
    if (!tee) {
      return problem(c, 503, "tee-unavailable", "TEE unavailable", "No TEE legs are configured.");
    }
    let ids: { requestId: string; mid: string };
    try {
      ids = readClosedMandate(body.closedMandate);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "The closed mandate does not parse.";
      return problem(c, 422, "invalid-closed-mandate", "Invalid closed mandate", detail);
    }

    const window = Math.floor(Date.now() / 1000 / RATE_WINDOW_SEC);
    const key = `rl:countersign:${ids.mid}:${window}`;
    try {
      const [count] = await kv.multi().incr(key).expire(key, RATE_WINDOW_SEC, "NX").exec();
      if (Number(count) > RATE_PER_MANDATE) {
        c.header("Retry-After", String(RATE_WINDOW_SEC));
        return problem(
          c,
          429,
          "rate-limited",
          "Too many requests",
          "Too many countersigns for this mandate.",
        );
      }
    } catch {
      // The store being down does not stop a countersign; the legs bound replays themselves.
    }

    const mandate = await db.query.mandates.findFirst({
      where: (row, { eq }) => eq(row.id, ids.mid),
    });
    if (!mandate) return problem(c, 404, "not-found", "Not found");
    if (!USABLE.has(mandate.state) || !mandate.openMandate || !mandate.mandateHash) {
      return problem(
        c,
        409,
        "mandate-not-active",
        "Mandate not active",
        "The mandate cannot countersign now.",
      );
    }

    const total = body.cart.lines.reduce(
      (sum, l) => sum + BigInt(l.qty) * BigInt(l.unit_minor),
      0n,
    );
    if (total <= 0n)
      return problem(c, 422, "invalid-cart", "Invalid cart", "The cart total must be positive.");
    const purchaseId = ids.requestId;
    const inserted = await db
      .insert(purchases)
      .values({
        id: purchaseId,
        mandateId: mandate.id,
        merchantId: body.cart.merchant,
        currency: body.cart.currency,
        amountMinor: total,
        cartHash: Buffer.from(cartHash(body.cart as Cart)),
      })
      .onConflictDoNothing()
      .returning({ id: purchases.id });
    if (inserted.length === 0) {
      return problem(
        c,
        409,
        "request-exists",
        "Request exists",
        "This request id was already used.",
      );
    }
    await transition(db, "purchases", purchaseId, "PROPOSED", "EVALUATING");

    try {
      const out = await countersign2of2(
        { db, kv, log, tee, verifyingContract: VERIFYING_CONTRACT },
        {
          request_id: ids.requestId,
          closed_mandate: body.closedMandate,
          sub: mandate.userId,
          cart: body.cart,
          unit: body.unit,
          evidence: body.evidence,
          evidence_root: body.evidenceRoot as `0x${string}`,
          authorization_id: body.authorizationId,
        },
      );
      if (out.countersign.mandateHash !== `0x${Buffer.from(mandate.mandateHash).toString("hex")}`) {
        await failPurchase(db, purchaseId, "mandate-mismatch");
        return problem(
          c,
          409,
          "mandate-not-active",
          "Mandate not active",
          "The countersign is for another mandate.",
        );
      }
      const allow = out.countersign.decision === "1";
      const patch = {
        countersignDigest: Buffer.from(hexToBytes(out.digest)),
        decision: Number(out.countersign.decision),
        failedFieldsMask: Number(out.countersign.failedFieldsMask),
      };
      await transition(
        db,
        "purchases",
        purchaseId,
        "EVALUATING",
        allow ? "COUNTERSIGNED" : "DENIED",
        patch,
      );
      return c.json(
        {
          purchaseId,
          mode: out.mode,
          decision: allow ? ("allow" as const) : ("deny" as const),
          countersign: out.countersign,
          digest: out.digest,
          signatures: out.signatures,
          signers: out.signers,
          trace: out.trace as Record<string, unknown>,
        },
        200,
      );
    } catch (err) {
      if (err instanceof CoordinatorError) {
        await failPurchase(db, purchaseId, err.slug);
        return problem(c, err.status, err.slug, err.message, undefined, undefined);
      }
      if (err instanceof LegError && err.kind === "problem") {
        await failPurchase(db, purchaseId, err.code ?? "leg-refused");
        const status = legStatus(err.code, err.status);
        return problem(c, status, err.code ?? "leg-refused", "A leg refused the request");
      }
      await failPurchase(db, purchaseId, "internal");
      throw err;
    }
  });
}
