import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { bindWebFact, type WebFactFields } from "@keelson/alibi";
import {
  type Cart,
  type Channel3Comparison,
  type CheckoutTotal,
  CURRENCIES,
  type CurrencyCode,
  cartHash,
  channel3Sources,
  fromPayPalAmount,
  isUlid,
  type Json,
  jcs,
  toHex,
} from "@keelson/core";
import {
  agentConnections,
  and,
  channel3Observations,
  type Db,
  desc,
  eq,
  evidenceBundles,
  evidenceItems,
  gt,
  inArray,
  isNull,
  like,
  mandates,
  ne,
  operators,
  or,
  purchaseHolds,
  purchases,
  sql,
  transition,
} from "@keelson/db";
import { decodeMandate, merchantLeaf } from "@keelson/mandate";
import type { Context } from "hono";
import { ulid } from "ulid";
import { hexToBytes } from "viem";
import type { Deps } from "../app.ts";
import { cartChecks } from "../cart-checks.ts";
import { deviceAuthorization, grantOf, requestOnce } from "../connections.ts";
import { approvedMandate, closeForHost, isDelegated, notAnotherApps } from "../delegated.ts";
import { capturable, merchantWebsite } from "../hold/state.ts";
import { MERCHANTS } from "../merchants.ts";
import { requireAgent } from "../middleware/auth.ts";
import { money, notify, purchaseAlert, requestAlert } from "../notify/notifier.ts";
import {
  drivePurchase,
  type FieldCheck,
  fieldChecks,
  type PipelineDeps,
  viewOf,
} from "../pipeline/drive.ts";
import { publishPurchase } from "../pipeline/events.ts";
import { logStep } from "../pipeline/log-step.ts";
import { principalKey } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { stoppedSince } from "../stop.ts";
import { LegError } from "../tee/client.ts";
import { VERIFYING_CONTRACT } from "../tee/config.ts";
import {
  CoordinatorError,
  type CountersignExpectation,
  countersign2of2,
} from "../tee/coordinator.ts";
import { span } from "../tracing.ts";
import { PurchaseProgress, progressOf } from "./purchases.ts";

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

export const CartSchema = z
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
    closedMandate: z.string().min(1).max(131_072).optional().openapi({
      description:
        "The open mandate closed by the agent's key binding over the request and cart. Required, except of an app acting for a user under a mandate of Keelson's hosted operator, which sends `mandateId` instead.",
    }),
    mandateId: z
      .string()
      .regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
      .optional()
      .openapi({
        description:
          "Only for an app acting for a user (`purchases:write`) under a mandate of Keelson's hosted operator that the user approved for it: Keelson closes the mandate with the hosted operator's key over `requestId` and this cart.",
      }),
    requestId: z
      .string()
      .regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
      .optional()
      .openapi({
        description:
          "With `mandateId`: the request ULID the closed mandate binds, and the purchase's id; a new one when left out.",
      }),
    cart: CartSchema,
    unit: z
      .record(z.string(), z.unknown())
      .refine((unit) => bytes(unit) <= MAX_UNIT_BYTES, "The purchase unit is too large.")
      .openapi({
        description:
          "The PayPal purchase unit the cart is checked against: `{amount}`, the checkout total the buyer pays as a PayPal Orders v2 amount, whose `breakdown` has the `item_total` of the cart's lines and, when the checkout charges them, `tax_total`, `shipping` and `discount`. Keelson countersigns `amount.value`, which must be `item_total + tax_total + shipping − discount`, and checks it against the mandate's budget. `handling`, `insurance` and `shipping_discount` are refused: fold them into `shipping`.",
      }),
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
    live: z
      .strictObject({
        store: z
          .url({ protocol: /^https$/ })
          .max(MAX_STRING)
          .refine(
            (s) => new URL(s).origin === s,
            "The store is an origin, such as https://shop.example.",
          )
          .openapi({
            description:
              "The store's origin: the origin of the website the mandate allows for the cart's merchant.",
          }),
      })
      .optional()
      .openapi({
        description:
          "Only when the buyer pays at the store's own checkout with their own PayPal account: Keelson countersigns and logs the purchase and issues its Alibi, and neither covers nor captures it. Its Alibi is public once the PayPal transaction is recorded. The agent's pay click waits for an ALLOW; the agent then records PayPal's transaction id with `PUT /v1/purchases/{id}/paypal-transaction`.",
      }),
    repeatOf: z.string().length(26).optional().openapi({
      description:
        "Only when the user asked to buy the same cart again: the id of the latest purchase of this cart under the mandate. Not needed once that purchase was denied or failed before capture, or was captured more than ten minutes ago. A retry after a lost answer never sends it: the `409 purchase-exists` answer names the purchase already made.",
    }),
  })
  .refine((b) => (b.closedMandate === undefined) !== (b.mandateId === undefined), {
    message: "Send closedMandate, or mandateId when Keelson closes the mandate.",
    path: ["closedMandate"],
  })
  .refine((b) => b.requestId === undefined || b.mandateId !== undefined, {
    message: "requestId goes with mandateId; a closed mandate carries its own.",
    path: ["requestId"],
  })
  .openapi("CountersignRequest");

const Approval = z
  .object({
    device_code: z.string().optional().openapi({
      description:
        "Absent when the user is already being asked about this cart: keep polling the device code you were given then.",
    }),
    user_code: z.string(),
    verification_uri: z.string(),
    verification_uri_complete: z.string(),
    expires_in: z.int(),
    interval: z.int(),
    request_id: z.string().openapi({
      description: "Read the request's state with `GET /v1/connections/requests/{id}`.",
    }),
  })
  .openapi("OnceApproval");

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
    approval: Approval.optional().openapi({
      description:
        "On a deny for a cart over the mandate's amount or outside its merchants: the user was asked to approve this cart once. Poll `POST /v1/connections/token` with its `device_code`; the answer is a single-purchase mandate for exactly this cart.",
    }),
    ...PurchaseProgress.shape,
  })
  .openapi("Countersigned");

const problemContent = { "application/problem+json": { schema: ProblemSchema } };

const route = createRoute({
  method: "post",
  path: "/v1/countersign",
  tags: ["tee"],
  summary: "Countersign a cart",
  description:
    "Sends the cart to the TEE legs in order and returns the countersignatures only when both agree. A DENY is countersigned too. An app acting for a user (`purchases:write`) countersigns only under a mandate that user approved for it; under a mandate of Keelson's hosted operator it sends `mandateId` and Keelson closes the mandate with that operator's key over the request id and this cart, and nothing else. A cart is bought once per mandate: while a purchase of the same cart is in flight, or for ten minutes after it was captured, another request for it is answered `409 purchase-exists` with that purchase's id, whatever its request id, evidence or `Idempotency-Key`. Retrying after a lost answer is therefore safe; to buy the same cart again on purpose, name that purchase in `repeatOf`.",
  middleware: [requireAgent("purchases:write")],
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
    202: {
      description:
        "Countersigned, and a step of the purchase is still pending; `Location` is the purchase, which finishes on its own",
      headers: z.object({ Location: z.string() }),
      content: { "application/json": { schema: Result } },
    },
    401: { description: "A leg refused the agent's authority", content: problemContent },
    409: {
      description:
        "The mandate is not active, the evidence root is not stored for it or already binds another purchase, the request was already used, or the same cart is already being bought (`purchase-exists`, with its `purchaseId`)",
      content: problemContent,
    },
    404: {
      description:
        "No such mandate of an operator this client linked, or that the user approved for this app",
      content: problemContent,
    },
    413: { description: "A leg refused the request as too large", content: problemContent },
    422: {
      description:
        "The request is invalid, the purchase unit's amount does not reconcile with the cart (`invalid-amount`), the authorization is not this purchase's hold, the cart is not the one held for this request, the evidence holds another cart or another checkout amount, its Channel3 observation is not usable, its WebFact is not this purchase's, or a live store is not the website the mandate allows",
      content: problemContent,
    },
    429: { description: "Too many countersigns for this mandate", content: problemContent },
    502: {
      description: "The legs disagree, or a signer is not registered",
      content: problemContent,
    },
    503: {
      description:
        "A leg needed to sign, or PayPal, is unavailable, or the hosted operator's key is not configured",
      content: problemContent,
    },
  },
});

const RATE_PER_MANDATE = 60;
const RATE_WINDOW_SEC = 60;
const PENDING = new Set(["COUNTERSIGNED", "LOGGED", "COVERED"]);
/** States of a purchase that may still capture. */
const IN_FLIGHT = ["PROPOSED", "EVALUATING", "COUNTERSIGNED", "LOGGED", "COVERED"] as const;
/** How long after a capture another purchase of the same cart needs `repeatOf`. */
const REPEAT_WINDOW_SEC = 600;

/**
 * The purchase a new purchase of the cart hashed `hash` under the mandate would repeat, other than
 * `except`: the latest one still in flight, or captured (or failed at capture) in the last ten
 * minutes. A countersign
 * for the same cart goes ahead only when it names this purchase as `repeatOf`.
 * @internal
 */
export async function latestOfCart(
  db: Pick<Db, "select">,
  mandateId: string,
  hash: `0x${string}`,
  except?: string,
): Promise<string | undefined> {
  const [latest] = await db
    .select({ id: purchases.id })
    .from(purchases)
    .where(
      and(
        eq(purchases.mandateId, mandateId),
        eq(purchases.cartHash, Buffer.from(hexToBytes(hash))),
        except === undefined ? undefined : ne(purchases.id, except),
        or(
          inArray(purchases.state, [...IN_FLIGHT]),
          gt(purchases.capturedAt, sql`now() - make_interval(secs => ${REPEAT_WINDOW_SEC})`),
          // A capture that failed after it was sent may still hold the money, until reconciled.
          and(
            eq(purchases.state, "FAILED"),
            like(purchases.failureReason, "capture:%"),
            gt(purchases.updatedAt, sql`now() - make_interval(secs => ${REPEAT_WINDOW_SEC})`),
          ),
        ),
      ),
    )
    .orderBy(desc(purchases.createdAt), desc(purchases.id))
    .limit(1);
  return latest?.id;
}
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
  db: Pick<Db, "select" | "update">,
  id: string,
  mandateId: string,
  want: CountersignExpectation,
  cart: { merchant: string; currency: string },
  evidenceRoot: Buffer,
  hold: { orderId: string; authorizationId: string },
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
  // The hold may have been reauthorized since; the countersign reads the current authorization.
  return transition(db, "purchases", id, "FAILED", "EVALUATING", {
    failureReason: null,
    paypalOrderId: hold.orderId,
    paypalAuthorizationId: hold.authorizationId,
  });
}

/** Whether the `api.checkout` item stored with the evidence is `amount`, as RFC 8785 JSON. */
function sameAmount(bytes: Buffer, amount: unknown): boolean {
  try {
    return jcs(JSON.parse(bytes.toString("utf8")) as Json) === jcs(amount as Json);
  } catch {
    return false;
  }
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

/**
 * Whether a denied cart is outside the mandate in a way one approval can fix: a store it does not
 * allow (onboarded, so a mandate can name it), or more than one purchase or what is left may cost.
 * `overMinor` is how far over, or null for the store.
 */
function outsideMandate(
  m: typeof mandates.$inferSelect,
  merchant: string,
  total: bigint,
): { overMinor: bigint | null } | undefined {
  if (!MERCHANTS.some((x) => x.id === merchant)) return undefined;
  if (!m.merchantIds.includes(merchant)) return { overMinor: null };
  let cap = m.remainingMinor;
  try {
    const grant =
      m.payloadSd && m.disclosures
        ? grantOf(decodeMandate(m.payloadSd as Record<string, unknown>, m.disclosures))
        : undefined;
    if (grant && grant.perPurchaseMinor < cap) cap = grant.perPurchaseMinor;
  } catch {
    // An undecodable mandate is judged by what is left of it.
  }
  return total > cap ? { overMinor: total - cap } : undefined;
}

/** The mandate fields a one-time approval may lift: how much, and at which store. */
const LIFTABLE = new Set(["total", "budget", "merchant"]);

/** Most carts of one mandate waiting for the user's answer at once. */
const MAX_OPEN_ONCE = 3;

/**
 * Whether every field the engine failed is one a one-time approval may lift; a cart denied for
 * anything else (its items, size, deadline) stays denied.
 */
function onlyOneApprovalFixes(trace: unknown): boolean {
  const fields = (trace as { fields?: { field?: unknown; pass?: unknown }[] } | null)?.fields;
  if (!Array.isArray(fields)) return false;
  const failed = fields.filter((f) => f.pass === false).map((f) => f.field);
  return failed.length > 0 && failed.every((f) => typeof f === "string" && LIFTABLE.has(f));
}

/** How long a countersign answer waits for the purchase to be logged, covered and captured. */
const INLINE_BUDGET_MS = 4_500;

export function registerCountersign(
  app: OpenAPIHono,
  deps: Pick<
    Deps,
    | "db"
    | "kv"
    | "log"
    | "tee"
    | "tlog"
    | "stamps"
    | "relayer"
    | "operators"
    | "chains"
    | "paypal"
    | "appOrigin"
    | "demoAgentId"
    | "hostedAgentKey"
    | "notifier"
  >,
): void {
  const { db, kv, log, tee } = deps;
  const pipeline: PipelineDeps = { ...deps, chain: deps.chains?.[421614] };
  const appOrigin = deps.appOrigin ?? "https://app.keelson.finance";

  /**
   * Asks the user to approve this cart once, unless they are already being asked for it: then the
   * agent keeps polling the device code it was given.
   */
  async function askOnce(
    c: Context,
    mandate: typeof mandates.$inferSelect,
    cart: Cart,
    total: bigint,
    hash: Buffer,
    overMinor: bigint | null,
    checks: FieldCheck[],
  ) {
    const clientId = c.var.principal?.subject as string;
    const [open] = await db
      .select({
        id: agentConnections.id,
        userCode: agentConnections.userCode,
        expiresAt: agentConnections.expiresAt,
      })
      .from(agentConnections)
      .where(
        and(
          eq(agentConnections.parentMandateId, mandate.id),
          eq(agentConnections.cartHash, hash),
          eq(agentConnections.clientId, clientId),
          eq(agentConnections.state, "PENDING"),
          gt(agentConnections.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (open) {
      const { device_code: _, ...shown } = deviceAuthorization(appOrigin, open, "");
      return {
        approval: {
          ...shown,
          expires_in: Math.ceil((open.expiresAt.getTime() - Date.now()) / 1000),
        },
      };
    }
    // A few open questions at a time: an agent cannot bury its user in approvals.
    const [{ pending = 0 } = {}] = await db
      .select({ pending: sql<number>`count(*)::int` })
      .from(agentConnections)
      .where(
        and(
          eq(agentConnections.parentMandateId, mandate.id),
          eq(agentConnections.state, "PENDING"),
          gt(agentConnections.expiresAt, new Date()),
        ),
      );
    if (pending >= MAX_OPEN_ONCE) return undefined;
    const approval = await requestOnce(
      { db, kv, appOrigin },
      {
        mandate,
        clientId,
        merchantId: cart.merchant,
        currency: cart.currency,
        amountMinor: total,
        cartHash: hash,
        cart,
        checks,
        overMinor,
      },
    );
    notify(deps.notifier, (n) => requestAlert(n, approval.request_id));
    return { approval };
  }

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
    const principal = c.var.principal as NonNullable<typeof c.var.principal>;
    const delegated = isDelegated(principal) ? principal : undefined;
    let ids: { requestId: string; mid: string };
    if (body.mandateId !== undefined) {
      // Only an app acting for a user has its mandate closed by Keelson.
      if (!delegated) {
        return problem(
          c,
          422,
          "invalid-closed-mandate",
          "Invalid closed mandate",
          "Close the mandate with your agent's key and send it as closedMandate.",
        );
      }
      ids = { requestId: body.requestId ?? ulid(), mid: body.mandateId };
    } else {
      try {
        ids = readClosedMandate(body.closedMandate as string);
      } catch (err) {
        const detail = err instanceof Error ? err.message : "The closed mandate does not parse.";
        return problem(c, 422, "invalid-closed-mandate", "Invalid closed mandate", detail);
      }
    }

    const window = Math.floor(Date.now() / 1000 / RATE_WINDOW_SEC);
    const caller = principalKey(principal);
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

    // The same answer for an unknown mandate and another client's or user's, so none is disclosed.
    const mandate = delegated
      ? await approvedMandate(db, delegated, ids.mid)
      : await db
          .select({ mandate: mandates, clientId: operators.clientId })
          .from(mandates)
          .innerJoin(operators, eq(operators.agentId, mandates.operatorAgentId))
          .where(and(eq(mandates.id, ids.mid), notAnotherApps(principal.subject)))
          .then(([found]) =>
            found?.clientId && found.clientId === principal.subject ? found.mandate : undefined,
          );
    if (!mandate) return problem(c, 404, "not-found", "Not found");
    // Keelson closes only mandates of its hosted operator, with that operator's key.
    const hostedKey =
      body.mandateId !== undefined && mandate.operatorAgentId === deps.demoAgentId
        ? deps.hostedAgentKey
        : undefined;
    if (body.mandateId !== undefined && mandate.operatorAgentId !== deps.demoAgentId) {
      return problem(
        c,
        422,
        "invalid-closed-mandate",
        "Invalid closed mandate",
        "This mandate names your own operator: close it with your agent's key and send it as closedMandate.",
      );
    }
    if (body.mandateId !== undefined && !hostedKey) {
      return problem(
        c,
        503,
        "hosted-key-unavailable",
        "Hosted operator unavailable",
        "Keelson's hosted operator cannot countersign now.",
      );
    }
    // A countersign is only worth something against a live hold.
    if (
      mandate.state !== "ACTIVE" ||
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

    // The agent pays a live purchase at the store, so the store is the one the user allowed.
    if (body.live) {
      let website: string | undefined;
      try {
        website = merchantWebsite(mandate, body.cart.merchant);
      } catch {
        website = undefined;
      }
      if (website === undefined || new URL(website).origin !== body.live.store) {
        return problem(
          c,
          422,
          "store-not-allowed",
          "Store not allowed",
          "The store is not the website the mandate allows for the cart's merchant.",
        );
      }
    }

    // A mandate whose merchant Keelson cannot capture for holds a budget only: the buyer pays
    // its purchases at the store's own checkout.
    if (
      !body.live &&
      deps.paypal &&
      mandate.holdMode !== "per_purchase" &&
      !capturable(deps.paypal, mandate)
    ) {
      return problem(
        c,
        422,
        "merchant-not-capturable",
        "Merchant not capturable",
        "Keelson cannot capture for this mandate's merchant: countersign its purchases as live.",
      );
    }

    // Leg A accepts a per-purchase hold for whatever mandate its request id is countersigned
    // under, so the hold must be this mandate's, this request's and authorized. A mandate that
    // holds its budget countersigns only on the authorization captures use now.
    let held: typeof purchaseHolds.$inferSelect | undefined;
    let holdsAuthorization: boolean;
    let orderId: string | null;
    if (mandate.holdMode === "per_purchase") {
      [held] = await db
        .select()
        .from(purchaseHolds)
        .where(eq(purchaseHolds.requestId, ids.requestId));
      holdsAuthorization =
        held?.mandateId === mandate.id &&
        held.state === "AUTHORIZED" &&
        held.paypalAuthorizationId === body.authorizationId;
      orderId = held?.paypalOrderId ?? null;
    } else {
      holdsAuthorization = mandate.paypalAuthorizationId === body.authorizationId;
      orderId = mandate.paypalOrderId;
    }
    if (!holdsAuthorization || orderId === null) {
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
          inArray(evidenceItems.type, [
            "api.product",
            "api.cart",
            "api.checkout",
            "channel3.observation",
            "tlsn.web_fact",
          ]),
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

    // The total the legs countersign, reconciled as the engine does: the items are the cart's and
    // the breakdown adds up to the value.
    let checkout: CheckoutTotal;
    try {
      checkout = fromPayPalAmount(body.unit.amount, body.cart as Cart);
    } catch (err) {
      return problem(
        c,
        422,
        "invalid-amount",
        "Invalid amount",
        `The purchase unit's amount is not the cart's checkout total: ${err instanceof Error ? err.message : "it does not parse"}.`,
      );
    }
    const total = BigInt(checkout.minor);
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
    const hashOfCart = Buffer.from(cartHash(body.cart as Cart));

    // The request the mandate answers: a one-time approval buys exactly the cart it was asked for.
    const [answered] = await db
      .select({
        kind: agentConnections.kind,
        askAbove: agentConnections.askAboveMinor,
        cartHash: agentConnections.cartHash,
      })
      .from(agentConnections)
      .where(
        and(eq(agentConnections.mandateId, mandate.id), eq(agentConnections.state, "APPROVED")),
      );
    if (answered?.kind === "once" && !answered.cartHash?.equals(hashOfCart)) {
      return problem(
        c,
        422,
        "not-the-approved-cart",
        "Not the approved cart",
        "This mandate was approved for one cart only, and this is another.",
      );
    }

    const want: CountersignExpectation = {
      cartHash: `0x${hashOfCart.toString("hex")}`,
      amount: total,
      merchantId: `0x${merchantId.toString(16).padStart(64, "0")}`,
      currency: currency.numeric,
      mandateHash: `0x${Buffer.from(mandate.mandateHash).toString("hex")}`,
    };

    if (held) {
      const differs =
        held.merchantId !== body.cart.merchant
          ? "merchant"
          : held.currency !== body.cart.currency
            ? "currency"
            : held.amountMinor !== total
              ? "amount"
              : `0x${held.cartHash.toString("hex")}` !== want.cartHash
                ? "cart hash"
                : undefined;
      if (differs) {
        return problem(
          c,
          422,
          "purchase-hold-mismatch",
          "Purchase hold mismatch",
          `The cart's ${differs} is not the one held for this request.`,
          { field: differs },
        );
      }
    }

    if (evidenceCartHash(evidence.cart) !== want.cartHash) {
      return problem(
        c,
        422,
        "evidence-cart-mismatch",
        "Evidence cart mismatch",
        "The cart the agent saw, as stored with the evidence, is not the cart to countersign.",
      );
    }

    // The Alibi discloses the checkout amount the evidence binds: it must be the one countersigned.
    // A total with tax, shipping or a discount is countersigned only with its breakdown in the
    // evidence, so its Alibi can show it.
    const quoted = item("api.checkout")?.bytes;
    const priced = checkout.tax > 0 || checkout.shipping > 0 || checkout.discount > 0;
    if (priced && !quoted) {
      return problem(
        c,
        422,
        "evidence-checkout-missing",
        "Evidence checkout missing",
        "A total with tax, shipping or a discount needs its PayPal amount stored with the evidence as an api.checkout item.",
      );
    }
    if (quoted && !sameAmount(quoted, body.unit.amount)) {
      return problem(
        c,
        422,
        "evidence-checkout-mismatch",
        "Evidence checkout mismatch",
        "The checkout amount stored with the evidence is not the purchase unit's amount.",
      );
    }

    // The Alibi discloses the WebFact; one that is not this purchase's would fail its verification.
    const notarized = item("tlsn.web_fact")?.bytes;
    if (notarized) {
      let website: string | undefined;
      try {
        website = merchantWebsite(mandate, body.cart.merchant);
      } catch {
        website = undefined;
      }
      let bound: ReturnType<typeof bindWebFact> | undefined;
      try {
        bound = bindWebFact(
          JSON.parse(notarized.toString("utf8")) as WebFactFields,
          body.cart as Cart,
          website,
          // The legs sign a little later than now: the Alibi measures the WebFact's age from then.
          Math.floor(Date.now() / 1000) + 60,
        );
      } catch {
        bound = undefined;
      }
      if (!bound || "reason" in bound) {
        return problem(
          c,
          422,
          "web-fact-mismatch",
          "WebFact mismatch",
          `The notarized product endpoint is not this purchase's: ${bound?.reason ?? "it is not a WebFact"}.`,
        );
      }
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

    // Above the user's "ask me above" a cart that passed every other check is paused for their
    // one-time approval, although the mandate would allow it.
    if (answered?.askAbove != null && total > answered.askAbove) {
      const asked = MERCHANTS.some((m) => m.id === body.cart.merchant)
        ? await askOnce(c, mandate, body.cart as Cart, total, hashOfCart, null, [
            ...cartChecks(mandate, body.cart as Cart),
            {
              field: "askAbove",
              mandate: money(answered.askAbove, body.cart.currency),
              cart: money(total, body.cart.currency),
              pass: false,
            },
          ])
        : undefined;
      if (!asked) {
        return problem(
          c,
          429,
          "too-many-approvals",
          "Too many approvals waiting",
          "The user already has carts of this mandate to answer.",
        );
      }
      return problem(
        c,
        409,
        "approval-required",
        "Paused for approval",
        `The cart is above the ${answered.askAbove} minor units the user asked to approve each time. The user was asked; poll POST /v1/connections/token with the device code.`,
        asked,
      );
    }

    const [bound] = await db
      .select({ id: purchases.id })
      .from(purchases)
      .where(eq(purchases.evidenceRoot, evidenceRoot));
    if (bound && bound.id !== purchaseId) return evidenceUsed(c);
    const claim = await db
      .transaction(async (tx) => {
        // A revoke updates this row, so it waits for this claim or this claim sees it: no purchase
        // is taken into evaluation once a revoke has been requested.
        const [live] = await tx
          .select({ id: mandates.id })
          .from(mandates)
          .where(
            and(
              eq(mandates.id, mandate.id),
              eq(mandates.state, "ACTIVE"),
              isNull(mandates.revokeRequestedAt),
            ),
          )
          .for("share");
        if (!live) return { revoked: true as const };
        // A stop of every agent stored first refuses each mandate stored before it, flagged or not.
        if (await stoppedSince(tx, mandate.userId, mandate.createdAt)) {
          return { revoked: true as const };
        }
        // Serializes the purchases of one cart under one mandate, so two retries cannot both pass.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`purchase:${mandate.id}:${want.cartHash}`}))`,
        );
        const latest = await latestOfCart(tx, mandate.id, want.cartHash, purchaseId);
        if (latest && latest !== body.repeatOf) return { exists: latest };
        const inserted = await tx
          .insert(purchases)
          .values({
            id: purchaseId,
            mandateId: mandate.id,
            merchantId: body.cart.merchant,
            currency: body.cart.currency,
            amountMinor: total,
            cartHash: Buffer.from(want.cartHash.slice(2), "hex"),
            evidenceRoot,
            paypalOrderId: orderId,
            paypalAuthorizationId: body.authorizationId,
            paypalRefSalt: randomBytes(32),
            ...(body.live ? { liveStore: body.live.store } : {}),
            ...(c.var.principal?.kind === "client" ? { clientId: c.var.principal.subject } : {}),
          })
          .onConflictDoNothing({ target: purchases.id })
          .returning({ id: purchases.id });
        // Taken into evaluation under the same lock, so the next holder sees it in flight.
        const driven =
          inserted.length > 0
            ? await transition(tx, "purchases", purchaseId, "PROPOSED", "EVALUATING")
            : await redrive(tx, purchaseId, mandate.id, want, body.cart, evidenceRoot, {
                orderId,
                authorizationId: body.authorizationId,
              });
        return { driven };
      })
      .catch((err: unknown) => {
        // A unique violation here is the evidence root: the id conflict is already ignored.
        const e = err as { code?: string; cause?: { code?: string } };
        if ((e.cause?.code ?? e.code) === "23505") return null;
        throw err;
      });
    if (claim === null) return evidenceUsed(c);
    if ("revoked" in claim) {
      return problem(
        c,
        409,
        "mandate-not-active",
        "Mandate not active",
        "The mandate cannot countersign now.",
      );
    }
    if ("exists" in claim) {
      c.header("Location", `/v1/purchases/${claim.exists}`);
      return problem(
        c,
        409,
        "purchase-exists",
        "Purchase exists",
        `Purchase ${claim.exists} of this cart is in flight or was captured in the last ten minutes; it is the answer to this request.`,
        { purchaseId: claim.exists },
      );
    }
    if (!claim.driven) {
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

    // Signed only once the purchase is claimed: over this request and the cart sent to the legs.
    let closedMandate = body.closedMandate as string;
    if (hostedKey) {
      try {
        closedMandate = await closeForHost(
          mandate.openMandate as string,
          ids.requestId,
          body.cart as Cart,
          hostedKey,
        );
      } catch (err) {
        log.error(
          { err, mandateId: mandate.id },
          "the hosted operator could not close the mandate",
        );
        await failPurchase(db, purchaseId, "hosted-key-unavailable");
        return problem(
          c,
          503,
          "hosted-key-unavailable",
          "Hosted operator unavailable",
          "Keelson's hosted operator cannot countersign now.",
        );
      }
    }

    try {
      const out = await span("purchase.COUNTERSIGNED", { "purchase.id": purchaseId }, async (s) => {
        const out = await countersign2of2(
          { db, kv, log, tee, verifyingContract: VERIFYING_CONTRACT },
          {
            request_id: ids.requestId,
            closed_mandate: closedMandate,
            sub: mandate.userId,
            cart: body.cart,
            unit: body.unit,
            evidence: evidenceSources,
            evidence_root: body.evidenceRoot as `0x${string}`,
            authorization_id: body.authorizationId,
            ...(mandate.sealedSalt
              ? { sealed_salt: Buffer.from(mandate.sealedSalt).toString("base64") }
              : {}),
          },
          want,
        );
        s.setAttribute("countersign.mode", out.mode);
        if (out.countersign.decision !== "1") s.updateName("purchase.DENIED");
        return out;
      });
      const allow = out.countersign.decision === "1";
      const patch = {
        countersignDigest: Buffer.from(hexToBytes(out.digest)),
        countersign: out.countersign,
        decision: Number(out.countersign.decision),
        failedFieldsMask: Number(out.countersign.failedFieldsMask),
        countersignMode: out.mode,
        evalTrace: out.trace,
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
      await publishPurchase(deps, purchaseId, {
        type: allow ? "purchase.countersigned" : "purchase.denied",
        mode: out.mode,
        digest: out.digest,
      });
      const driving = allow
        ? drivePurchase(pipeline, purchaseId)
        : logStep(pipeline, purchaseId).then(async () => viewOf(db, purchaseId));
      driving.catch((err: unknown) => log.error({ err, purchaseId }, "purchase not driven"));
      const budget = new AbortController();
      const view =
        (await Promise.race([
          driving,
          delay(INLINE_BUDGET_MS, undefined, { signal: budget.signal }),
        ])
          .catch(() => undefined)
          .finally(() => budget.abort())) ?? (await viewOf(db, purchaseId));
      const pending = view === undefined || PENDING.has(view.state);
      // A cart over the mandate's amount or outside its stores is paused for the user's one-time
      // approval, never silently declined.
      const outside =
        allow || !onlyOneApprovalFixes(out.trace)
          ? undefined
          : outsideMandate(mandate, body.cart.merchant, total);
      const asked =
        outside === undefined
          ? undefined
          : await askOnce(
              c,
              mandate,
              body.cart as Cart,
              total,
              hashOfCart,
              outside.overMinor,
              fieldChecks(out.trace, body.cart.currency),
            );
      // A cart paused for the user is announced as a request; one simply refused, once logged.
      if (!allow && !asked) {
        const blocked = () => notify(deps.notifier, (n) => purchaseAlert(n, purchaseId, "blocked"));
        driving.then(blocked, blocked);
      }
      c.header("Keelson-Countersign-Mode", out.mode);
      if (pending) c.header("Location", `/v1/purchases/${purchaseId}`);
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
          ...(asked ? { approval: asked.approval } : {}),
          ...progressOf(view),
        },
        pending ? 202 : 200,
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
