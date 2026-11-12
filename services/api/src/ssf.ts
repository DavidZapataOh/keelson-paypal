import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, type Db, eq, inArray, isNull, ssfEvents, ssfStreams } from "@keelson/db";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { signJWT } from "better-auth/plugins/jwt";
import type { Context, MiddlewareHandler } from "hono";
import { ulid } from "ulid";
import type { Deps } from "./app.ts";
import type { Auth } from "./auth.ts";
import { requirePrincipal } from "./middleware/auth.ts";
import type { Principal } from "./principal.ts";
import { ProblemSchema, problem } from "./problem.ts";

/**
 * CAEP 1.0 §3.1: a session the user had with the receiver was revoked.
 * @internal
 */
export const CAEP_SESSION_REVOKED =
  "https://schemas.openid.net/secevent/caep/event-type/session-revoked";
const POLL = "urn:ietf:rfc:8936";

/**
 * Signs Security Event Tokens (RFC 8417) with the authorization server's own signing key, typed
 * `secevent+jwt` (RFC 8417 §2.3), so a receiver verifies them against the same JWKS.
 */
export const securityEvents = () =>
  ({
    id: "keelson-security-events",
    endpoints: {
      signSecurityEvent: createAuthEndpoint.serverOnly(
        { method: "POST", body: z.object({ payload: z.record(z.string(), z.any()) }) },
        async (ctx) =>
          ctx.json({
            token: await signJWT(ctx, {
              payload: ctx.body.payload,
              header: { typ: "secevent+jwt" },
            }),
          }),
      ),
    },
  }) satisfies BetterAuthPlugin;

/**
 * Queues one CAEP `session-revoked` SET for every enabled stream of `userId` (only `clientId`'s,
 * when given): the user stopped every agent, or disconnected that app.
 */
export async function emitSessionRevoked(
  deps: { db: Db; auth?: Auth | undefined; ssfIssuer: string },
  x: { userId: string; clientId?: string; at: Date; reason: string },
): Promise<void> {
  if (!deps.auth) return;
  const streams = await deps.db
    .select()
    .from(ssfStreams)
    .where(
      and(
        eq(ssfStreams.userId, x.userId),
        eq(ssfStreams.status, "enabled"),
        ...(x.clientId ? [eq(ssfStreams.clientId, x.clientId)] : []),
      ),
    );
  for (const s of streams) {
    const jti = ulid();
    const { token } = await deps.auth.api.signSecurityEvent({
      body: {
        payload: {
          iss: deps.ssfIssuer,
          jti,
          iat: Math.floor(Date.now() / 1000),
          aud: s.clientId,
          sub_id: { format: "iss_sub", iss: deps.ssfIssuer, sub: x.userId },
          events: {
            [CAEP_SESSION_REVOKED]: {
              event_timestamp: Math.floor(x.at.getTime() / 1000),
              initiating_entity: "user",
              reason_admin: { en: x.reason },
            },
          },
        },
      },
    });
    await deps.db.insert(ssfEvents).values({ jti, streamId: s.id, set: token });
  }
}

const problemContent = { "application/problem+json": { schema: ProblemSchema } };

const StreamConfig = z
  .object({
    stream_id: z.string(),
    iss: z.string(),
    aud: z.string(),
    delivery: z.object({ method: z.literal(POLL), endpoint_url: z.string() }),
    events_supported: z.array(z.string()),
    events_requested: z.array(z.string()),
    events_delivered: z.array(z.string()),
  })
  .openapi("SsfStream");

const createStream = createRoute({
  method: "post",
  path: "/ssf/streams",
  operationId: "createSsfStream",
  tags: ["agents"],
  summary: "Create the app's Shared Signals stream",
  description:
    "An app acting for a user creates its stream (OpenID SSF 1.0 §8.1.1), polled per RFC 8936, and is told by CAEP `session-revoked` when the user stops every agent or disconnects it.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            delivery: z.object({ method: z.literal(POLL) }),
            events_requested: z.array(z.string()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: StreamConfig } } },
    403: { description: "Not an app acting for a user", content: problemContent },
    409: { description: "The app already has a stream for this user", content: problemContent },
  },
});

const deleteStream = createRoute({
  method: "delete",
  path: "/ssf/streams",
  operationId: "deleteSsfStream",
  tags: ["agents"],
  summary: "Delete the app's Shared Signals stream",
  request: { query: z.object({ stream_id: z.string() }) },
  responses: {
    204: { description: "Deleted" },
    403: { description: "Not an app acting for a user", content: problemContent },
    404: { description: "No such stream of this app", content: problemContent },
  },
});

const pollRoute = createRoute({
  method: "post",
  path: "/ssf/poll",
  operationId: "pollSsfEvents",
  tags: ["agents"],
  summary: "Poll the app's security events (RFC 8936)",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            ack: z.array(z.string()).max(100).optional(),
            maxEvents: z.int().min(0).max(100).optional(),
            returnImmediately: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Events not yet acknowledged",
      content: {
        "application/json": {
          schema: z.object({ sets: z.record(z.string(), z.string()), moreAvailable: z.boolean() }),
        },
      },
    },
    403: { description: "Not an app acting for a user", content: problemContent },
    404: { description: "The app has no stream for this user", content: problemContent },
  },
});

/** The app and user of a delegated token; anything else may not hold a stream. */
function receiver(c: Context): { clientId: string; userId: string } | undefined {
  const p = c.get("principal") as Principal | undefined;
  return p?.kind === "client" && p.user ? { clientId: p.subject, userId: p.user } : undefined;
}

export function registerSsf(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "authBaseUrl" | "authenticate">,
): void {
  const base = (deps.authBaseUrl ?? "https://api.keelson.finance").replace(/\/$/, "");
  const { db } = deps;
  const notApp = (c: Context) =>
    problem(c, 403, "forbidden", "Forbidden", "Only an app acting for a user has a stream.");

  app.get("/.well-known/ssf-configuration", (c) =>
    c.json(
      {
        spec_version: "1_0",
        issuer: base,
        jwks_uri: `${base}/api/auth/jwks`,
        delivery_methods_supported: [POLL],
        configuration_endpoint: `${base}/ssf/streams`,
        authorization_schemes: [{ spec_urn: "urn:ietf:rfc:6749" }],
        default_subjects: "ALL",
      },
      200,
      { "access-control-allow-origin": "*" },
    ),
  );

  if (deps.authenticate) app.use("/ssf/*", deps.authenticate as MiddlewareHandler);
  app.use("/ssf/*", requirePrincipal());

  const config = (s: typeof ssfStreams.$inferSelect) => ({
    stream_id: s.id,
    iss: base,
    aud: s.clientId,
    delivery: { method: POLL, endpoint_url: `${base}/ssf/poll` } as const,
    events_supported: [CAEP_SESSION_REVOKED],
    events_requested: [CAEP_SESSION_REVOKED],
    events_delivered: [CAEP_SESSION_REVOKED],
  });

  app.openapi(createStream, async (c) => {
    const r = receiver(c);
    if (!r) return notApp(c);
    const [created] = await db
      .insert(ssfStreams)
      .values({ id: ulid(), ...r })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      return problem(c, 409, "request-exists", "Stream exists", "This app has a stream already.");
    }
    return c.json(config(created), 201);
  });

  const own = async (r: { clientId: string; userId: string }) =>
    (
      await db
        .select()
        .from(ssfStreams)
        .where(and(eq(ssfStreams.clientId, r.clientId), eq(ssfStreams.userId, r.userId)))
    )[0];

  app.openapi(deleteStream, async (c) => {
    const r = receiver(c);
    if (!r) return notApp(c);
    const s = await own(r);
    if (!s || s.id !== c.req.valid("query").stream_id) {
      return problem(c, 404, "not-found", "Not found");
    }
    await db.delete(ssfStreams).where(eq(ssfStreams.id, s.id));
    return c.body(null, 204);
  });

  app.openapi(pollRoute, async (c) => {
    const r = receiver(c);
    if (!r) return notApp(c);
    const s = await own(r);
    if (!s) return problem(c, 404, "not-found", "Not found");
    const body = c.req.valid("json");
    if (body.ack?.length) {
      await db
        .update(ssfEvents)
        .set({ ackedAt: new Date() })
        .where(and(eq(ssfEvents.streamId, s.id), inArray(ssfEvents.jti, body.ack)));
    }
    const max = body.maxEvents ?? 25;
    const rows =
      max === 0
        ? []
        : await db
            .select({ jti: ssfEvents.jti, set: ssfEvents.set })
            .from(ssfEvents)
            .where(and(eq(ssfEvents.streamId, s.id), isNull(ssfEvents.ackedAt)))
            .orderBy(asc(ssfEvents.createdAt))
            .limit(max + 1);
    return c.json(
      {
        sets: Object.fromEntries(rows.slice(0, max).map((e) => [e.jti, e.set])),
        moreAvailable: rows.length > max,
      },
      200,
    );
  });
}
