import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  type Cart,
  type Channel3Comparison,
  CURRENCIES,
  type CurrencyCode,
  cartHash,
  channel3Sources,
  isUlid,
  toHex,
} from "@keelson/core";
import {
  and,
  channel3Observations,
  type Db,
  eq,
  evidenceBundles,
  evidenceItems,
  gt,
  inArray,
  isNull,
  or,
  purchaseHolds,
  purchases,
  sql,
  transition,
} from "@keelson/db";
import { merchantLeaf } from "@keelson/mandate";
import type { Context } from "hono";
import { hexToBytes } from "viem";
import type { Deps } from "../app.ts";
import { requireClient } from "../middleware/auth.ts";
import { principalKey } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { LegError } from "../tee/client.ts";
import { VERIFYING_CONTRACT } from "../tee/config.ts";
import {
  CoordinatorError,
  type CountersignExpectation,
  countersign2of2,
} from "../tee/coordinator.ts";

const Hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const Hex = (bytes: number) => z.string().regex(new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`));

/**
 * Leg B evaluates inside a timeout of half a second and a leg that misses it is skipped, so the
 * size of what it evaluates is bounded here.
 */
const MAX_LINES = 32;
const MAX_STRING = 256;
const MAX_EVIDENCE_FIELDS = 16;
const MAX_SOURCES = 8;
const MAX_EVIDENCE_BYTES = 8_192;
const MAX_UNIT_BYTES = 8_192;

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** An observation is usable for as long as the countersign it feeds may take to be asked for. */
const OBSERVATION_TTL_SEC = 900;
const fold = (s: string) => s.normalize("NFKC").trim().toUpperCase().toLowerCase();

const CartSchema = z
  .object({
    merchant: z.string().min(1).max(MAX_STRING),
    currency: z.string().length(3),
    lines: z
      .array(
        z.object({
          sku: z.string().max(MAX_STRING),
          size: z.string().max(MAX_STRING).nullable().optional(),
          color: z.string().max(MAX_STRING).nullable().optional(),
          category: z.string().max(MAX_STRING),
          qty: z.number().int().positive(),
          unit_minor: z.number().int().nonnegative(),
        }),
      )
      .min(1)
      .max(MAX_LINES),
    return_days: z.number().int().nonnegative(),
    returns_free: z.boolean(),
  })
  .openapi("Cart");

const Body = z
  .object({
    authorizationId: z.string().min(1).max(64).openapi({
      description:
        "The PayPal authorization that holds the mandate's funds, or this request's own hold when the mandate holds each purchase separately; leg A reads it.",
    }),
    closedMandate: z.string().min(1).max(131_072).openapi({
      description: "The open mandate closed by the agent's key binding over the request and cart.",
    }),
    cart: CartSchema,
    unit: z
      .record(z.string(), z.unknown())
      .refine((unit) => bytes(unit) <= MAX_UNIT_BYTES, "The purchase unit is too large.")
      .openapi({ description: "The PayPal purchase unit the cart is checked against." }),
    evidence: z
      .record(z.string(), z.array(z.string().max(MAX_STRING)).max(MAX_SOURCES))
      .refine((e) => Object.keys(e).length <= MAX_EVIDENCE_FIELDS, "Too many evidence fields.")
      .refine((e) => bytes(e) <= MAX_EVIDENCE_BYTES, "The evidence is too large.")
      .default({})
      .openapi({
        description:
          "Evidence sources per field. `channel3:` sources are refused here: the API adds them from the observation stored in the evidence.",
      }),
    evidenceRoot: Hex32.openapi({
      description: "The root of the evidence stored with `POST /v1/evidence` for this mandate.",
    }),
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
      headers: z.object({
        "Keelson-Countersign-Mode": z.enum(["2of2", "degraded"]).openapi({
          description: "`degraded` when only one TEE signed; the same as `mode` in the body.",
        }),
      }),
      content: { "application/json": { schema: Result } },
    },
    401: { description: "A leg refused the agent's authority", content: problemContent },
    409: {
      description:
        "The mandate is not active, the evidence root is not stored for it or already binds another purchase, or the request was already used",
      content: problemContent,
    },
    404: { description: "No such mandate", content: problemContent },
    413: { description: "A leg refused the request as too large", content: problemContent },
    422: {
      description:
        "The request is invalid, the authorization is not this purchase's hold, the evidence holds another cart, or its Channel3 observation is not usable",
      content: problemContent,
    },
    429: { description: "Too many countersigns for this mandate", content: problemContent },
    502: {
      description: "The legs disagree, or a signer is not registered",
      content: problemContent,
    },
    503: {
      description: "A leg needed to sign, or PayPal, is unavailable",
      content: problemContent,
    },
  },
});

const RATE_PER_MANDATE = 60;
const RATE_WINDOW_SEC = 60;
const USABLE = new Set(["SIGNED", "HOLD_PENDING", "ACTIVE"]);
/** Failures that say nothing about the request, so the same request id may be driven again. */
const RETRYABLE = new Set(["tee-unavailable", "paypal-unavailable", "stale"]);

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

/**
 * Takes a purchase that failed for a transient reason back into evaluation, if it is the same
 * request. Leg A holds one reservation per mandate and request id, so driving it again does not
 * reserve twice. Only one of several concurrent retries wins.
 */
async function redrive(
  db: Db,
  id: string,
  mandateId: string,
  want: CountersignExpectation,
  cart: { merchant: string; currency: string },
  evidenceRoot: Buffer,
): Promise<boolean> {
  const [row] = await db.select().from(purchases).where(eq(purchases.id, id));
  if (!row) return false;
  if (
    row.state !== "FAILED" ||
    !row.evidenceRoot?.equals(evidenceRoot) ||
    !RETRYABLE.has(row.failureReason ?? "") ||
    row.mandateId !== mandateId ||
    row.amountMinor !== want.amount ||
    row.merchantId !== cart.merchant ||
    row.currency !== cart.currency ||
    `0x${row.cartHash.toString("hex")}` !== want.cartHash
  ) {
    return false;
  }
  return transition(db, "purchases", id, "FAILED", "EVALUATING", { failureReason: null });
}

/** The cart hash of the `api.cart` item stored with the evidence, or `null` if it has none. */
function evidenceCartHash(bytes: Buffer | null): string | null {
  if (!bytes) return null;
  try {
    return `0x${Buffer.from(cartHash(JSON.parse(bytes.toString("utf8")) as Cart)).toString("hex")}`;
  } catch {
    return null;
  }
}

function evidenceUsed(c: Context) {
  return problem(
    c,
    409,
    "evidence-used",
    "Evidence used",
    "The evidence root already binds another purchase.",
  );
}

/** Fails the purchase and frees the observation it claimed, so the same request can retry. */
async function failPurchase(db: Db, id: string, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    await transition(tx, "purchases", id, "EVALUATING", "FAILED", { failureReason: reason });
    await tx
      .update(channel3Observations)
      .set({ purchaseId: null })
      .where(eq(channel3Observations.purchaseId, id));
  });
}

interface StoredView {
  price_minor?: unknown;
  currency?: unknown;
  selected?: { name: string; label: string }[];
}

/**
 * Whether the agent's view describes a line of the cart being countersigned: its price and
 * currency, and its size and color where the view names them. The view is the agent's word, so
 * it only counts when it is the purchase itself that Channel3 is compared with.
 */
function viewDescribesCart(
  view: StoredView | undefined,
  cart: z.infer<typeof CartSchema>,
): boolean {
  if (!view || view.currency !== cart.currency) return false;
  return cart.lines.some(
    (line) =>
      String(line.unit_minor) === view.price_minor &&
      (view.selected ?? []).every((option) => {
        const name = fold(option.name);
        const value = name === "size" ? line.size : name === "color" ? line.color : undefined;
        return value === undefined || (value !== null && fold(value) === fold(option.label));
      }),
  );
}

function observationInvalid(c: Context, detail: string) {
  return problem(c, 422, "observation-invalid", "Observation invalid", detail);
}

/** The comparison stored in a `keelson.channel3.observation/1` document. */
function storedComparison(document: unknown): Channel3Comparison {
  const c = (document as { comparison: Record<string, unknown> }).comparison;
  return {
    offerDomain: c.offer_domain as string | null,
    variant: c.variant as Channel3Comparison["variant"],
    price: c.price as Channel3Comparison["price"],
    availability: c.availability as Channel3Comparison["availability"],
    brand: c.brand as Channel3Comparison["brand"],
    mismatches: c.mismatches as string[],
  };
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
    if (
      Object.entries(body.evidence).some(
        ([field, sources]) =>
          fold(field).startsWith("channel3") || sources.some((s) => fold(s).startsWith("channel3")),
      )
    ) {
      return problem(
        c,
        422,
        "invalid-evidence",
        "Invalid evidence",
        "channel3: sources are added by Keelson from the stored observation, never by the agent.",
      );
    }
    let ids: { requestId: string; mid: string };
    try {
      ids = readClosedMandate(body.closedMandate);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "The closed mandate does not parse.";
      return problem(c, 422, "invalid-closed-mandate", "Invalid closed mandate", detail);
    }

    const window = Math.floor(Date.now() / 1000 / RATE_WINDOW_SEC);
    const caller = principalKey(c.var.principal as NonNullable<typeof c.var.principal>);
    const key = `rl:countersign:${caller}:${ids.mid}:${window}`;
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
    if (
      !USABLE.has(mandate.state) ||
      mandate.revokeRequestedAt !== null ||
      !mandate.openMandate ||
      !mandate.mandateHash
    ) {
      return problem(
        c,
        409,
        "mandate-not-active",
        "Mandate not active",
        "The mandate cannot countersign now.",
      );
    }

    // Leg A accepts a per-purchase hold for whatever mandate its request id is countersigned
    // under, so the hold must be this mandate's and this request's.
    const [held] = await db
      .select({ mandateId: purchaseHolds.mandateId, requestId: purchaseHolds.requestId })
      .from(purchaseHolds)
      .where(eq(purchaseHolds.paypalAuthorizationId, body.authorizationId));
    if (
      held
        ? held.mandateId !== mandate.id || held.requestId !== ids.requestId
        : mandate.holdMode === "per_purchase"
    ) {
      return problem(
        c,
        422,
        "authorization-not-held",
        "Authorization not held",
        "The authorization is not the hold of this mandate for this request.",
      );
    }

    const evidenceRoot = Buffer.from(hexToBytes(body.evidenceRoot as `0x${string}`));
    const rows = await db
      .select({
        type: evidenceItems.type,
        bytes: evidenceItems.bytes,
        contentHash: evidenceItems.contentHash,
        salt: evidenceItems.salt,
      })
      .from(evidenceBundles)
      .leftJoin(
        evidenceItems,
        and(
          eq(evidenceItems.root, evidenceBundles.root),
          inArray(evidenceItems.type, ["api.product", "api.cart", "channel3.observation"]),
        ),
      )
      .where(
        and(eq(evidenceBundles.root, evidenceRoot), eq(evidenceBundles.mandateId, mandate.id)),
      );
    const item = (type: string) => rows.find((r) => r.type === type);
    const evidence = rows.length > 0 ? { cart: item("api.cart")?.bytes ?? null } : undefined;
    if (!evidence) {
      return problem(
        c,
        409,
        "evidence-unknown",
        "Evidence unknown",
        "The evidence root is not stored for this mandate; upload it to /v1/evidence first.",
      );
    }

    const total = body.cart.lines.reduce(
      (sum, l) => sum + BigInt(l.qty) * BigInt(l.unit_minor),
      0n,
    );
    if (total <= 0n)
      return problem(c, 422, "invalid-cart", "Invalid cart", "The cart total must be positive.");
    const currency = CURRENCIES[body.cart.currency as CurrencyCode];
    let merchantId: bigint;
    try {
      merchantId = await merchantLeaf(body.cart.merchant);
    } catch {
      return problem(c, 422, "invalid-cart", "Invalid cart", "The merchant id is not valid.");
    }
    if (!currency) {
      return problem(c, 422, "invalid-cart", "Invalid cart", "The currency is not supported.");
    }
    const want: CountersignExpectation = {
      cartHash: `0x${Buffer.from(cartHash(body.cart as Cart)).toString("hex")}`,
      amount: total,
      merchantId: `0x${merchantId.toString(16).padStart(64, "0")}`,
      currency: currency.numeric,
      mandateHash: `0x${Buffer.from(mandate.mandateHash).toString("hex")}`,
    };

    if (evidenceCartHash(evidence.cart) !== want.cartHash) {
      return problem(
        c,
        422,
        "evidence-cart-mismatch",
        "Evidence cart mismatch",
        "The cart the agent saw, as stored with the evidence, is not the cart to countersign.",
      );
    }

    const purchaseId = ids.requestId;
    let evidenceSources = body.evidence;
    let observationId: string | undefined;
    const observed = item("channel3.observation");
    if (observed?.contentHash && observed.salt) {
      const [obs] = await db
        .select({
          id: channel3Observations.id,
          mandateId: channel3Observations.mandateId,
          purchaseId: channel3Observations.purchaseId,
          url: channel3Observations.url,
          salt: channel3Observations.salt,
          document: channel3Observations.document,
          // Both sides of the window on the database clock.
          fresh: sql<boolean>`${channel3Observations.createdAt} > now() - make_interval(secs => ${OBSERVATION_TTL_SEC})`,
        })
        .from(channel3Observations)
        .where(eq(channel3Observations.contentHash, observed.contentHash));
      const productHash = item("api.product")?.contentHash;
      const view = (obs?.document as { agent_view?: StoredView & { content_hash?: unknown } })
        ?.agent_view;
      if (!obs?.salt.equals(observed.salt)) {
        return observationInvalid(
          c,
          "The Channel3 observation in the evidence was not issued by Keelson.",
        );
      }
      if (obs.mandateId !== mandate.id) {
        return observationInvalid(c, "The Channel3 observation belongs to another mandate.");
      }
      if (obs.purchaseId !== null && obs.purchaseId !== purchaseId) {
        return observationInvalid(c, "The Channel3 observation already serves another purchase.");
      }
      if (!obs.fresh) {
        return observationInvalid(c, "The Channel3 observation is older than 900 seconds.");
      }
      if (!productHash || view?.content_hash !== toHex(productHash)) {
        return observationInvalid(
          c,
          "The Channel3 observation compares a view that is not this evidence's api.product item.",
        );
      }
      if (!viewDescribesCart(view, body.cart)) {
        return observationInvalid(
          c,
          "The Channel3 observation compares a price, currency, size or color that is not the cart's.",
        );
      }
      // Only the latest observation of a page counts: an agent cannot keep the answer it liked.
      const [newer] = await db
        .select({ id: channel3Observations.id })
        .from(channel3Observations)
        .where(
          and(
            eq(channel3Observations.mandateId, mandate.id),
            eq(channel3Observations.url, obs.url),
            // Compared in SQL: the column keeps microseconds, a JavaScript Date does not.
            gt(
              channel3Observations.createdAt,
              sql`(select created_at from channel3_observations where id = ${obs.id})`,
            ),
          ),
        )
        .limit(1);
      if (newer) {
        return observationInvalid(c, "A newer Channel3 observation of this page exists.");
      }
      const added = channel3Sources(obs.id, storedComparison(obs.document));
      evidenceSources = { ...body.evidence };
      for (const [field, sources] of Object.entries(added)) {
        evidenceSources[field] = [...(evidenceSources[field] ?? []), ...sources];
      }
      if (
        Object.keys(evidenceSources).length > MAX_EVIDENCE_FIELDS ||
        Object.values(evidenceSources).some((s) => s.length > MAX_SOURCES) ||
        bytes(evidenceSources) > MAX_EVIDENCE_BYTES
      ) {
        return problem(
          c,
          422,
          "evidence-too-large",
          "Evidence too large",
          "The evidence with the Channel3 sources added exceeds the evidence limits.",
        );
      }
      observationId = obs.id;
    }

    const [bound] = await db
      .select({ id: purchases.id })
      .from(purchases)
      .where(eq(purchases.evidenceRoot, evidenceRoot));
    if (bound && bound.id !== purchaseId) return evidenceUsed(c);
    const inserted = await db
      .insert(purchases)
      .values({
        id: purchaseId,
        mandateId: mandate.id,
        merchantId: body.cart.merchant,
        currency: body.cart.currency,
        amountMinor: total,
        cartHash: Buffer.from(want.cartHash.slice(2), "hex"),
        evidenceRoot,
      })
      .onConflictDoNothing({ target: purchases.id })
      .returning({ id: purchases.id })
      .catch((err: unknown) => {
        // A unique violation here is the evidence root: the id conflict is already ignored.
        const e = err as { code?: string; cause?: { code?: string } };
        if ((e.cause?.code ?? e.code) === "23505") return null;
        throw err;
      });
    if (inserted === null) return evidenceUsed(c);
    const driven =
      inserted.length > 0
        ? await transition(db, "purchases", purchaseId, "PROPOSED", "EVALUATING")
        : await redrive(db, purchaseId, mandate.id, want, body.cart, evidenceRoot);
    if (!driven) {
      return problem(
        c,
        409,
        "request-exists",
        "Request exists",
        "This request id was already used.",
      );
    }
    if (observationId) {
      const claimed = await db
        .update(channel3Observations)
        .set({ purchaseId })
        .where(
          and(
            eq(channel3Observations.id, observationId),
            or(
              isNull(channel3Observations.purchaseId),
              eq(channel3Observations.purchaseId, purchaseId),
            ),
          ),
        )
        .returning({ id: channel3Observations.id });
      if (claimed.length === 0) {
        await failPurchase(db, purchaseId, "observation-invalid");
        return observationInvalid(c, "The Channel3 observation already serves another purchase.");
      }
    }

    try {
      const out = await countersign2of2(
        { db, kv, log, tee, verifyingContract: VERIFYING_CONTRACT },
        {
          request_id: ids.requestId,
          closed_mandate: body.closedMandate,
          sub: mandate.userId,
          cart: body.cart,
          unit: body.unit,
          evidence: evidenceSources,
          evidence_root: body.evidenceRoot as `0x${string}`,
          authorization_id: body.authorizationId,
        },
        want,
      );
      const allow = out.countersign.decision === "1";
      const patch = {
        countersignDigest: Buffer.from(hexToBytes(out.digest)),
        countersign: out.countersign,
        decision: Number(out.countersign.decision),
        failedFieldsMask: Number(out.countersign.failedFieldsMask),
        countersignMode: out.mode,
        failureReason: null,
      };
      await transition(
        db,
        "purchases",
        purchaseId,
        "EVALUATING",
        allow ? "COUNTERSIGNED" : "DENIED",
        patch,
      );
      c.header("Keelson-Countersign-Mode", out.mode);
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
