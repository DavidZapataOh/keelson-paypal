import { createHash, randomBytes } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { type Draft, toMandate } from "@keelson/compiler";
import { CURRENCIES, type CurrencyCode } from "@keelson/core";
import { agentConnections, and, eq, isNull, mandates, operators, sql } from "@keelson/db";
import {
  buildSdPayload,
  CATEGORY_TABLE,
  decodeMandate,
  MAX_LIFETIME_SECONDS,
  type Mandate,
  renderCard,
} from "@keelson/mandate";
import type { Context } from "hono";
import { ulid } from "ulid";
import type { Deps } from "../app.ts";
import { agentBond, operatorAgent } from "../compile-sources.ts";
import {
  type Connection,
  deviceAuthorization,
  hashDeviceCode,
  newDeviceCode,
  normalizeUserCode,
  openRequest,
  REQUEST_TTL_SEC,
  withFreshUserCode,
} from "../connections.ts";
import { publishEvent } from "../events.ts";
import { MERCHANTS } from "../merchants.ts";
import { requireClient, requireSession } from "../middleware/auth.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { type Principal, principalChannel } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { signingContext } from "./compile.ts";
import { Card } from "./mandates.ts";

const problemContent = { "application/problem+json": { schema: ProblemSchema } };

/** Text the user reads as the agent wrote it: no control or format characters to hide or reorder it. */
const shown = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((s) => s.isWellFormed() && !/[\p{Cc}\p{Cf}]/u.test(s), "control or format characters");

const Minor = z.int().positive().max(Number.MAX_SAFE_INTEGER);

/** Limits as an agent asks for them, or as a user lowers them. */
export const Limits = z
  .object({
    currency: z.enum(Object.keys(CURRENCIES) as [CurrencyCode, ...CurrencyCode[]]).default("USD"),
    perPurchaseMinor: Minor.openapi({ description: "Most one purchase may cost, minor units." }),
    totalMinor: Minor.openapi({ description: "Most all purchases may cost together." }),
    merchants: z
      .array(z.enum(MERCHANTS.map((m) => m.id) as [string, ...string[]]))
      .min(1)
      .max(MERCHANTS.length)
      .default(MERCHANTS.map((m) => m.id))
      .openapi({ description: "Onboarded merchant ids; every one when left out." }),
    until: z.iso.datetime({ offset: true }).openapi({ description: "When the mandate ends." }),
    askAboveMinor: Minor.optional().openapi({
      description:
        "Above this a purchase waits for the user's one-time approval, although the limits allow it.",
    }),
  })
  .refine((l) => l.perPurchaseMinor <= l.totalMinor, {
    message: "perPurchaseMinor exceeds totalMinor",
    path: ["perPurchaseMinor"],
  })
  .refine((l) => l.askAboveMinor === undefined || l.askAboveMinor <= l.perPurchaseMinor, {
    message: "askAboveMinor exceeds perPurchaseMinor",
    path: ["askAboveMinor"],
  })
  .openapi("ConnectionLimits");
export type Limits = z.infer<typeof Limits>;

/** What an agent asks for: who it is, why, and the limits. */
export const ConnectionRequest = z
  .object({
    name: shown(1, 64).openapi({ example: "Claude Code" }),
    reason: shown(100, 1000).openapi({
      description: "Why the agent asks, in its own words; the user reads it before approving.",
    }),
    limits: Limits,
  })
  .openapi("ConnectionRequest");

const DeviceAuthorizationSchema = z
  .object({
    device_code: z.string(),
    user_code: z.string(),
    verification_uri: z.string(),
    verification_uri_complete: z.string(),
    expires_in: z.int(),
    interval: z.int(),
  })
  .openapi("DeviceAuthorization", {
    description:
      "RFC 8628 §3.2. Show `user_code` and `verification_uri` to the user, then poll `POST /v1/connections/token` every `interval` seconds.",
  });

const TokenError = z
  .object({
    error: z.enum([
      "authorization_pending",
      "slow_down",
      "access_denied",
      "expired_token",
      "invalid_grant",
      "unsupported_grant_type",
    ]),
    error_description: z.string(),
    interval: z.int().optional(),
  })
  .openapi("ConnectionTokenError");

const Approved = z
  .object({
    mandate_id: z.string(),
    kind: z.enum(["connect", "once"]),
  })
  .openapi("ConnectionApproved");

const ConnectionView = z
  .object({
    code: z.string(),
    kind: z.enum(["connect", "once"]),
    state: z.enum(["PENDING", "APPROVED", "DENIED", "EXPIRED"]),
    name: z.string(),
    reason: z.string(),
    agent: z.object({
      agentId: z.string(),
      operator: z.string(),
      bond: z.object({ asset: z.string(), min: z.number(), vault: z.string() }).nullable(),
    }),
    limits: z.object({
      currency: z.string(),
      perPurchaseMinor: z.string(),
      totalMinor: z.string(),
      askAboveMinor: z.string().nullable(),
      merchants: z.array(z.object({ id: z.string(), name: z.string() })),
      until: z.string(),
    }),
    parent: z
      .object({
        mandateId: z.string(),
        perPurchaseMinor: z.string(),
        remainingMinor: z.string(),
      })
      .nullable(),
    mandateId: z.string().nullable(),
    expiresAt: z.string(),
  })
  .openapi("Connection");

const DraftRequest = z
  .object({
    limits: z.object({
      perPurchaseMinor: Minor,
      totalMinor: Minor,
      merchants: z.array(z.string()).min(1),
      until: z.iso.datetime({ offset: true }),
      askAboveMinor: Minor.optional(),
    }),
    credentialId: z.string().min(1).optional(),
  })
  .openapi("ConnectionDraft");

const Code = z.object({ code: z.string().min(8).max(16) });

const create = createRoute({
  method: "post",
  path: "/v1/connections",
  tags: ["connections"],
  summary: "Ask the user for a mandate",
  description:
    "The agent's operator asks its user for a mandate with these limits, as an RFC 8628 device authorization: the user opens `verification_uri_complete`, compares `user_code` and approves on Keelson's page with a passkey, lowering any limit. Only a client that linked an operator may ask, and the mandate names that operator. The code expires in 15 minutes and is single use.",
  middleware: [requireClient(["countersign:write"])],
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(255) }),
    body: { required: true, content: { "application/json": { schema: ConnectionRequest } } },
  },
  responses: {
    201: {
      description: "Show the code and the link to the user, then poll",
      content: { "application/json": { schema: DeviceAuthorizationSchema } },
    },
    401: { description: "No valid access token", content: problemContent },
    403: { description: "The client linked no operator", content: problemContent },
    409: { description: "The client linked several operators", content: problemContent },
    422: { description: "The request is invalid", content: problemContent },
  },
});

const token = createRoute({
  method: "post",
  path: "/v1/connections/token",
  tags: ["connections"],
  summary: "Poll for the user's answer",
  description:
    "RFC 8628 §3.4 polling with `grant_type=urn:ietf:params:oauth:grant-type:device_code`. Until the user decides: `authorization_pending`, or `slow_down` (and 5 more seconds to wait) when polled faster than `interval`. Then `access_denied`, `expired_token`, or the approved mandate's id, once: the device code is spent by the answer that carries it.",
  middleware: [requireClient(["countersign:write"])],
  request: {
    body: {
      required: true,
      content: {
        "application/x-www-form-urlencoded": {
          schema: z.object({ grant_type: z.string(), device_code: z.string().max(256) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Approved: the mandate the user signed",
      content: { "application/json": { schema: Approved } },
    },
    400: {
      description: "Not approved, or not yet",
      content: { "application/json": { schema: TokenError } },
    },
    401: { description: "No valid access token", content: problemContent },
  },
});

const read = createRoute({
  method: "get",
  path: "/v1/connections/{code}",
  tags: ["connections"],
  summary: "Read a request by its user code",
  description:
    "What the agent asks for, for the approval page. Limited to 20 reads a minute per user, so codes cannot be guessed.",
  middleware: [requireSession()],
  request: { params: Code },
  responses: {
    200: {
      description: "The request",
      content: { "application/json": { schema: ConnectionView } },
    },
    401: { description: "Not signed in", content: problemContent },
    404: { description: "No such request for this user", content: problemContent },
    429: { description: "Too many reads", content: problemContent },
  },
});

const deny = createRoute({
  method: "post",
  path: "/v1/connections/{code}/deny",
  tags: ["connections"],
  summary: "Deny a request",
  middleware: [requireSession()],
  request: {
    params: Code,
    headers: z.object({ "idempotency-key": z.string().min(1).max(255) }),
  },
  responses: {
    200: {
      description: "Denied; the agent's next poll says `access_denied`",
      content: { "application/json": { schema: z.object({ state: z.literal("DENIED") }) } },
    },
    401: { description: "Not signed in", content: problemContent },
    404: { description: "No open request with this code", content: problemContent },
  },
});

const draft = createRoute({
  method: "post",
  path: "/v1/connections/{code}/draft",
  tags: ["connections"],
  summary: "Draft the mandate that approves a request",
  description:
    "The unsigned mandate for the limits the user chose, which may only be lower than or equal to what the agent asked. It names the asking agent's operator. Sign it and store it with `POST /v1/mandates`, passing `connection`, to approve.",
  middleware: [requireSession()],
  request: {
    params: Code,
    headers: z.object({
      "idempotency-key": z.string().min(1).max(255),
      "keelson-device": z.string().optional(),
    }),
    body: { required: true, content: { "application/json": { schema: DraftRequest } } },
  },
  responses: {
    200: {
      description: "The draft mandate and its card",
      content: {
        "application/json": {
          schema: z.object({
            mandateDraft: z.record(z.string(), z.unknown()),
            card: Card,
            ambiguous: z.array(z.string()),
            check: z.object({ status: z.literal("skipped"), discrepancies: z.null() }),
          }),
        },
      },
    },
    401: { description: "Not signed in", content: problemContent },
    403: { description: "The passkey is not the user's", content: problemContent },
    404: { description: "No open request with this code", content: problemContent },
    409: { description: "The user has no passkey", content: problemContent },
    422: {
      description: "A limit is above what the agent asked (`limits-raised`; `fields` names it)",
      content: problemContent,
    },
    503: { description: "The operator's agent key or bond is not set", content: problemContent },
  },
});

/** The fields of `chosen` above what `request` asked for. */
function raised(
  chosen: Pick<Limits, "perPurchaseMinor" | "totalMinor" | "merchants" | "until"> & {
    askAboveMinor?: number | undefined;
  },
  request: Connection,
): string[] {
  const out: string[] = [];
  if (BigInt(chosen.perPurchaseMinor) > request.perPurchaseMinor) out.push("perPurchase");
  if (BigInt(chosen.totalMinor) > request.totalMinor) out.push("total");
  if (chosen.merchants.some((m) => !request.merchantIds.includes(m))) out.push("merchants");
  if (Date.parse(chosen.until) > request.notAfter.getTime()) out.push("until");
  if (request.askAboveMinor !== null && chosen.askAboveMinor === undefined) out.push("askAbove");
  if (
    chosen.askAboveMinor !== undefined &&
    BigInt(chosen.askAboveMinor) > (request.askAboveMinor ?? request.perPurchaseMinor)
  ) {
    out.push("askAbove");
  }
  return out;
}

/**
 * What a mandate for `request` allows besides money, stores and time: anything, for an agent's
 * standing request; for one cart outside a mandate, only what that mandate allowed, so a one-time
 * approval lifts its amount or store and nothing else.
 */
async function inherited(
  db: Deps["db"],
  request: Connection,
): Promise<Pick<Draft, "category" | "attributes" | "returns">> {
  const open = { category: [...CATEGORY_TABLE.ids], attributes: {}, returns: null };
  if (request.kind !== "once" || !request.parentMandateId) return open;
  const [parent] = await db
    .select({ payloadSd: mandates.payloadSd, disclosures: mandates.disclosures })
    .from(mandates)
    .where(eq(mandates.id, request.parentMandateId));
  if (!parent?.payloadSd || !parent.disclosures)
    throw new Error("the parent mandate is not signed");
  const m = decodeMandate(parent.payloadSd as Record<string, unknown>, parent.disclosures);
  const of = <T extends Mandate["checkout"]["constraints"][number]["type"]>(type: T) =>
    m.checkout.constraints.find((c) => c.type === type) as
      | Extract<Mandate["checkout"]["constraints"][number], { type: T }>
      | undefined;
  const returns = of("keelson.returns");
  return {
    category: of("keelson.category")?.allow ?? open.category,
    attributes: of("keelson.attributes")?.must ?? {},
    returns: returns ? { minDays: returns.min_days, free: returns.free } : null,
  };
}

/** The error a request's limits fail with, if any, before it is stored. */
export function invalidLimits(limits: Limits, now = Date.now()): string | undefined {
  const until = Date.parse(limits.until);
  if (until <= now) return "until has passed";
  if (until > now + MAX_LIFETIME_SECONDS * 1000) return "until is more than 30 days away";
  return undefined;
}

/** Stores a `connect` request for the operator the client linked, with fresh codes. */
export async function storeRequest(
  deps: Pick<Deps, "db">,
  input: {
    clientId: string;
    operatorAgentId: bigint;
    name: string;
    reason: string;
    limits: Limits;
    /** The user it is bound to from the start, when the request comes from their own consent. */
    userId?: string;
  },
): Promise<{ userCode: string; deviceCode: string }> {
  const device = newDeviceCode();
  const { limits } = input;
  const userCode = await withFreshUserCode((userCode) =>
    deps.db.insert(agentConnections).values({
      id: ulid(),
      kind: "connect",
      clientId: input.clientId,
      operatorAgentId: input.operatorAgentId,
      name: input.name,
      reason: input.reason,
      userCode,
      deviceCodeHash: device.hash,
      currency: limits.currency,
      perPurchaseMinor: BigInt(limits.perPurchaseMinor),
      totalMinor: BigInt(limits.totalMinor),
      askAboveMinor: limits.askAboveMinor === undefined ? null : BigInt(limits.askAboveMinor),
      merchantIds: limits.merchants,
      notAfter: new Date(limits.until),
      expiresAt: new Date(Date.now() + REQUEST_TTL_SEC * 1000),
      ...(input.userId ? { userId: input.userId } : {}),
    }),
  );
  return { userCode, deviceCode: device.code };
}

const tokenError = (
  c: Context,
  error: z.infer<typeof TokenError>["error"],
  description: string,
  interval?: number,
) =>
  c.json(
    { error, error_description: description, ...(interval ? { interval } : {}) },
    400,
    // RFC 6749 §5.1: token responses are never cached.
    { "cache-control": "no-store" },
  );

export function registerConnections(
  app: OpenAPIHono,
  deps: Pick<
    Deps,
    "db" | "kv" | "log" | "appOrigin" | "passkeyRpId" | "rateLimit" | "compileSources"
  >,
): void {
  const { db } = deps;
  const appOrigin = deps.appOrigin ?? "https://app.keelson.finance";

  app.openapi(create, async (c) => {
    const clientId = (c.get("principal") as Principal).subject;
    const body = c.req.valid("json");
    const [operator, another] = await db
      .select({ agentId: operators.agentId })
      .from(operators)
      .where(eq(operators.clientId, clientId));
    if (!operator) {
      return problem(
        c,
        403,
        "no-operator",
        "No operator",
        "Link this client to its operator with POST /v1/operators/{agentId}/link first.",
      );
    }
    // The mandate names one agent; a client acting for several cannot say which here.
    if (another) {
      return problem(
        c,
        409,
        "several-operators",
        "Several operators",
        "This client is linked to more than one operator; use one client per agent.",
      );
    }
    const invalid = invalidLimits(body.limits);
    if (invalid) return problem(c, 422, "invalid-limits", "Invalid limits", invalid);
    const { userCode, deviceCode } = await storeRequest(deps, {
      clientId,
      operatorAgentId: operator.agentId,
      name: body.name,
      reason: body.reason,
      limits: body.limits,
    });
    return c.json(deviceAuthorization(appOrigin, userCode, deviceCode), 201, {
      "cache-control": "no-store",
    });
  });

  app.openapi(token, async (c) => {
    const clientId = (c.get("principal") as Principal).subject;
    const body = c.req.valid("form");
    if (body.grant_type !== "urn:ietf:params:oauth:grant-type:device_code") {
      return tokenError(c, "unsupported_grant_type", "Use the device_code grant.");
    }
    const [row] = await db
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.deviceCodeHash, hashDeviceCode(body.device_code)));
    // Another client's code is as unknown as a wrong one.
    if (!row || row.clientId !== clientId || row.redeemedAt) {
      return tokenError(c, "invalid_grant", "The device code is not valid.");
    }
    if (row.state === "DENIED") return tokenError(c, "access_denied", "The user said no.");
    // An approval is collected within one more request lifetime, or the session is over.
    if (row.expiresAt.getTime() + REQUEST_TTL_SEC * 1000 <= Date.now()) {
      return tokenError(c, "expired_token", "The device code has expired.");
    }
    if (row.state === "APPROVED" && row.mandateId) {
      const [spent] = await db
        .update(agentConnections)
        .set({ redeemedAt: new Date() })
        .where(and(eq(agentConnections.id, row.id), isNull(agentConnections.redeemedAt)))
        .returning({ id: agentConnections.id });
      if (!spent) return tokenError(c, "invalid_grant", "The device code is not valid.");
      return c.json({ mandate_id: row.mandateId, kind: row.kind }, 200, {
        "cache-control": "no-store",
      });
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      return tokenError(c, "expired_token", "The code expired before the user decided.");
    }
    // The interval is enforced against the last poll on the database clock.
    const [polled] = await db
      .update(agentConnections)
      .set({
        polledAt: sql`now()`,
        pollInterval: sql`case when ${agentConnections.polledAt} > now() - make_interval(secs => ${agentConnections.pollInterval}) then ${agentConnections.pollInterval} + 5 else ${agentConnections.pollInterval} end`,
      })
      .where(eq(agentConnections.id, row.id))
      .returning({ interval: agentConnections.pollInterval });
    if (polled && polled.interval > row.pollInterval) {
      return tokenError(c, "slow_down", "Poll less often.", polled.interval);
    }
    return tokenError(c, "authorization_pending", "The user has not decided yet.");
  });

  // RFC 8628 §5.1: every route that tells a live user code from a dead one shares one budget, so
  // codes cannot be guessed; approving one also takes a passkey signature.
  const codeLimit = rateLimit(deps.kv, {
    name: "connection-code",
    limit: 20,
    windowSec: 60,
    failClosed: true,
  });
  app.use("/v1/connections/:code/*", codeLimit);
  app.use("/v1/connections/:code", (c, next) =>
    c.req.method === "GET" ? codeLimit(c, next) : next(),
  );

  app.openapi(read, async (c) => {
    const userId = (c.get("principal") as Principal).subject;
    const code = normalizeUserCode(c.req.valid("param").code);
    const [row] = code
      ? await db
          .select({ request: agentConnections, operator: operators })
          .from(agentConnections)
          .innerJoin(operators, eq(operators.agentId, agentConnections.operatorAgentId))
          .where(eq(agentConnections.userCode, code))
      : [];
    // An expired request nobody opened stays private to the agent that made it.
    const lapsed =
      row?.request.state === "PENDING" && row.request.expiresAt.getTime() <= Date.now();
    if (
      !row ||
      (row.request.userId !== null && row.request.userId !== userId) ||
      (lapsed && row.request.userId === null)
    ) {
      return problem(c, 404, "not-found", "Not found");
    }
    const { request, operator } = row;
    const parent = request.parentMandateId
      ? await db.query.mandates.findFirst({
          where: (m, { eq: is }) => is(m.id, request.parentMandateId as string),
        })
      : undefined;
    const bond = agentBond(operator);
    const expired = request.state === "PENDING" && request.expiresAt.getTime() <= Date.now();
    return c.json(
      {
        code: request.userCode,
        kind: request.kind,
        state: expired ? ("EXPIRED" as const) : request.state,
        name: request.name,
        reason: request.reason,
        agent: {
          agentId: operator.agentId.toString(),
          operator: operator.name,
          bond: bond ? { asset: bond.asset, min: bond.min, vault: bond.vault } : null,
        },
        limits: {
          currency: request.currency,
          perPurchaseMinor: request.perPurchaseMinor.toString(),
          totalMinor: request.totalMinor.toString(),
          askAboveMinor: request.askAboveMinor?.toString() ?? null,
          merchants: request.merchantIds.map((id) => ({
            id,
            name: MERCHANTS.find((m) => m.id === id)?.name ?? id,
          })),
          until: request.notAfter.toISOString(),
        },
        parent: parent
          ? {
              mandateId: parent.id,
              perPurchaseMinor: parent.maxMinor.toString(),
              remainingMinor: parent.remainingMinor.toString(),
            }
          : null,
        mandateId: request.mandateId,
        expiresAt: request.expiresAt.toISOString(),
      },
      200,
    );
  });

  app.openapi(deny, async (c) => {
    const userId = (c.get("principal") as Principal).subject;
    const code = normalizeUserCode(c.req.valid("param").code);
    const request = code ? await openRequest(db, code) : undefined;
    if (!request || (request.userId !== null && request.userId !== userId)) {
      return problem(c, 404, "not-found", "Not found");
    }
    const [denied] = await db
      .update(agentConnections)
      .set({ state: "DENIED", userId, decidedAt: new Date() })
      .where(and(eq(agentConnections.id, request.id), eq(agentConnections.state, "PENDING")))
      .returning({ id: agentConnections.id });
    if (!denied) return problem(c, 404, "not-found", "Not found");
    await publishEvent(
      deps,
      principalChannel({ kind: "client", subject: request.clientId }, "connections"),
      request.id,
      { type: "connection.denied", userCode: request.userCode },
    );
    return c.json({ state: "DENIED" as const }, 200);
  });

  app.openapi(draft, async (c) => {
    const userId = (c.get("principal") as Principal).subject;
    const code = normalizeUserCode(c.req.valid("param").code);
    const request = code ? await openRequest(db, code) : undefined;
    if (!request || (request.userId !== null && request.userId !== userId)) {
      return problem(c, 404, "not-found", "Not found");
    }
    const body = c.req.valid("json");
    const over = raised(body.limits, request);
    if (over.length > 0) {
      return problem(
        c,
        422,
        "limits-raised",
        "Limits raised",
        `${over.join(", ")} must not be above what ${request.name} asked for; raising it takes a new request.`,
        { fields: over },
      );
    }
    const mode = request.kind === "once" ? "immediate" : "autonomous";
    const context = await signingContext(
      c,
      deps,
      userId,
      { credentialId: body.credentialId, mode },
      operatorAgent(db, request.operatorAgentId),
    );
    if (context instanceof Response) return context;
    const iat = Math.floor(Date.now() / 1000);
    const until = Math.min(
      Math.floor(Date.parse(body.limits.until) / 1000),
      Math.floor(request.notAfter.getTime() / 1000),
    );
    if (until <= iat) {
      return problem(c, 422, "invalid-limits", "Invalid limits", "until has passed");
    }
    const { mandate, ambiguous } = toMandate(
      {
        currency: request.currency as CurrencyCode,
        maxTotalMinor: body.limits.perPurchaseMinor,
        budgetMinor: body.limits.totalMinor,
        merchants: body.limits.merchants.map(
          (id) => MERCHANTS.find((m) => m.id === id)?.name ?? id,
        ),
        ...(await inherited(db, request)),
        notAfter: new Date(until * 1000).toISOString(),
        quantityPerLine: 1,
        item: request.kind === "once" ? "This cart only" : "Any item at the stores allowed",
        subjective: [],
        summary: request.reason,
      },
      {
        ...context,
        mid: ulid(),
        iat,
        nonce: randomBytes(16).toString("base64url"),
        merchants: MERCHANTS,
      },
      {
        promptHash: `sha256:${createHash("sha256").update(request.reason, "utf8").digest("hex")}`,
      },
    );
    const { payloadSd, disclosures } = await buildSdPayload(mandate, () => randomBytes(16));
    const card = renderCard(payloadSd, disclosures, {
      merchantSignedCheckout: false,
      zkTlsFields: new Set(),
      ambiguous: new Set(ambiguous),
    });
    return c.json(
      {
        mandateDraft: mandate as unknown as Record<string, unknown>,
        card,
        ambiguous,
        check: { status: "skipped" as const, discrepancies: null },
      },
      200,
    );
  });
}
