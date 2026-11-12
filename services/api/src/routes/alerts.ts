import { randomBytes } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { alertEmails, and, desc, eq, pushSubscriptions, sentEmails } from "@keelson/db";
import type { Context } from "hono";
import { ulid } from "ulid";
import type { Deps } from "../app.ts";
import { requireSession } from "../middleware/auth.ts";
import { addressHash, CONFIRM_TTL_SEC, sendEmail, signLink, verifyLink } from "../notify/email.ts";
import { composeEmail, type Notifier, unsubscribeLinks } from "../notify/notifier.ts";
import { sendPush } from "../notify/push.ts";
import type { Principal } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";

const problemContent = { "application/problem+json": { schema: ProblemSchema } };
const unavailable = { description: "Alerts are not configured", content: problemContent };

/** A `PushSubscription` serialized with `toJSON()` (W3C Push API). */
const Subscription = z
  .object({
    endpoint: z.url({ protocol: /^https$/ }).max(2048),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({
      p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/),
      auth: z.string().regex(/^[A-Za-z0-9_-]{16,32}$/),
    }),
  })
  .openapi("PushSubscription");

const EmailState = z
  .object({
    address: z.string().nullable(),
    confirmed: z.boolean(),
  })
  .openapi("AlertEmail");

const SentEmail = z
  .object({
    id: z.string(),
    address: z.string(),
    event: z.string(),
    subject: z.string(),
    subjectId: z.string().nullable(),
    logIndex: z.string().nullable(),
    alibiUrl: z.string().nullable(),
    sentAt: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("SentEmail");

const pushKey = createRoute({
  method: "get",
  path: "/v1/push/key",
  operationId: "getPushKey",
  tags: ["alerts"],
  summary: "Read the push key",
  description:
    "The VAPID public key (RFC 8292) to pass as `applicationServerKey` to `PushManager.subscribe()`.",
  middleware: [requireSession()],
  responses: {
    200: {
      description: "The key, base64url",
      content: { "application/json": { schema: z.object({ publicKey: z.string() }) } },
    },
    401: { description: "Not signed in", content: problemContent },
    503: unavailable,
  },
});

const subscribe = createRoute({
  method: "post",
  path: "/v1/push/subscriptions",
  operationId: "createPushSubscription",
  tags: ["alerts"],
  summary: "Get alerts on this browser",
  description:
    "Stores the browser's push subscription: agent requests, blocked carts and stops are pushed to it.",
  middleware: [requireSession()],
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(255) }),
    body: { required: true, content: { "application/json": { schema: Subscription } } },
  },
  responses: {
    201: {
      description: "Subscribed",
      content: { "application/json": { schema: z.object({ id: z.string() }) } },
    },
    401: { description: "Not signed in", content: problemContent },
  },
});

const unsubscribePush = createRoute({
  method: "delete",
  path: "/v1/push/subscriptions",
  operationId: "deletePushSubscription",
  tags: ["alerts"],
  summary: "Stop alerts on this browser",
  middleware: [requireSession()],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ endpoint: z.string().max(2048) }) } },
    },
  },
  responses: {
    204: { description: "Removed" },
    401: { description: "Not signed in", content: problemContent },
  },
});

const testPush = createRoute({
  method: "post",
  path: "/v1/push/test",
  operationId: "sendTestPush",
  tags: ["alerts"],
  summary: "Send a test notification",
  middleware: [requireSession()],
  request: { headers: z.object({ "idempotency-key": z.string().min(1).max(255) }) },
  responses: {
    200: {
      description: "How many browsers' push services accepted it",
      content: { "application/json": { schema: z.object({ sent: z.int() }) } },
    },
    401: { description: "Not signed in", content: problemContent },
    503: unavailable,
  },
});

const readEmail = createRoute({
  method: "get",
  path: "/v1/alerts/email",
  operationId: "getAlertEmail",
  tags: ["alerts"],
  summary: "Read your alert address",
  middleware: [requireSession()],
  responses: {
    200: { description: "The address", content: { "application/json": { schema: EmailState } } },
    401: { description: "Not signed in", content: problemContent },
  },
});

const setEmail = createRoute({
  method: "put",
  path: "/v1/alerts/email",
  operationId: "setAlertEmail",
  tags: ["alerts"],
  summary: "Set your alert address",
  description:
    "Stores the address unconfirmed and sends it a confirmation link, signed, single use and valid for 24 hours. Alerts are emailed only once it is confirmed. Never the sign-in address unless entered here.",
  middleware: [requireSession()],
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: z.object({ address: z.email().max(254) }) },
      },
    },
  },
  responses: {
    202: {
      description: "The confirmation link was sent",
      content: { "application/json": { schema: EmailState } },
    },
    401: { description: "Not signed in", content: problemContent },
    429: { description: "A link was sent less than a minute ago", content: problemContent },
    503: unavailable,
  },
});

const removeEmail = createRoute({
  method: "delete",
  path: "/v1/alerts/email",
  operationId: "deleteAlertEmail",
  tags: ["alerts"],
  summary: "Stop email alerts",
  middleware: [requireSession()],
  responses: {
    204: { description: "Removed" },
    401: { description: "Not signed in", content: problemContent },
  },
});

const confirm = createRoute({
  method: "post",
  path: "/v1/alerts/email/confirm",
  operationId: "confirmAlertEmail",
  tags: ["alerts"],
  summary: "Confirm an alert address",
  description: "Opened from the confirmation link; needs no session. A link works once.",
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(255) }),
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ token: z.string().max(1024) }) } },
    },
  },
  responses: {
    200: {
      description: "Confirmed",
      content: { "application/json": { schema: z.object({ address: z.string() }) } },
    },
    404: { description: "The link is invalid, used or expired", content: problemContent },
    503: unavailable,
  },
});

const unsubscribe = createRoute({
  method: "post",
  path: "/v1/alerts/unsubscribe",
  operationId: "unsubscribeAlerts",
  tags: ["alerts"],
  summary: "Unsubscribe in one click",
  description:
    "The `List-Unsubscribe` URI of every alert email (RFC 8058): the mail client posts `List-Unsubscribe=One-Click` to it, with no session or other context. The token in the query names the address.",
  request: { query: z.object({ token: z.string().max(1024) }) },
  responses: {
    200: {
      description: "No more email goes to the address",
      content: { "application/json": { schema: z.object({ unsubscribed: z.literal(true) }) } },
    },
    404: { description: "The link is invalid", content: problemContent },
    503: unavailable,
  },
});

const trail = createRoute({
  method: "get",
  path: "/v1/alerts/emails",
  operationId: "listAlertEmails",
  tags: ["alerts"],
  summary: "List the emails sent to you",
  description: "Every alert email composed for you, newest first, with what it reported.",
  middleware: [requireSession()],
  responses: {
    200: {
      description: "The emails",
      content: { "application/json": { schema: z.object({ emails: z.array(SentEmail) }) } },
    },
    401: { description: "Not signed in", content: problemContent },
  },
});

const notConfigured = (c: Context) =>
  problem(c, 503, "alerts-unavailable", "Alerts unavailable", "Alerts are not configured.");

/** Sends the one confirmation link that works for the address. */
async function sendConfirmation(n: Notifier, userId: string, address: string): Promise<void> {
  const nonce = randomBytes(16).toString("base64url");
  await n.db
    .insert(alertEmails)
    .values({ userId, address, confirmNonce: nonce })
    .onConflictDoUpdate({
      target: alertEmails.userId,
      set: { address, confirmNonce: nonce, confirmedAt: null },
    });
  const token = signLink(n.secret, {
    p: "confirm",
    u: userId,
    n: nonce,
    exp: Math.floor(Date.now() / 1000) + CONFIRM_TTL_SEC,
  });
  const links = unsubscribeLinks(n, userId, address);
  await sendEmail(
    n,
    { userId, address, unsubscribeUrl: links.oneClick },
    composeEmail(
      {
        event: "email.confirm",
        title: "Confirm your email for Keelson alerts",
        body: "Keelson emails you when an agent needs your approval, when it blocks a cart, when a purchase is paid and when you stop your agents. Confirm this address to start. The link works once, for 24 hours.",
        url: `${n.appOrigin}/alerts/confirm/?token=${token}`,
        action: "Confirm this address",
        push: null,
      },
      links.page,
    ),
  );
}

export function registerAlerts(app: OpenAPIHono, deps: Pick<Deps, "db" | "kv" | "notifier">): void {
  const { db } = deps;
  const userOf = (c: Context) => (c.get("principal") as Principal).subject;

  app.openapi(pushKey, (c) => {
    const vapid = deps.notifier?.vapid;
    if (!vapid) return notConfigured(c);
    return c.json({ publicKey: vapid.publicKey }, 200);
  });

  app.openapi(subscribe, async (c) => {
    const { endpoint, keys } = c.req.valid("json");
    // An endpoint belongs to one browser profile: whoever subscribes it last gets its alerts.
    const [row] = await db
      .insert(pushSubscriptions)
      .values({ id: ulid(), userId: userOf(c), endpoint, p256dh: keys.p256dh, auth: keys.auth })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { userId: userOf(c), p256dh: keys.p256dh, auth: keys.auth },
      })
      .returning({ id: pushSubscriptions.id });
    return c.json({ id: row?.id as string }, 201);
  });

  app.openapi(unsubscribePush, async (c) => {
    await db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.userId, userOf(c)),
          eq(pushSubscriptions.endpoint, c.req.valid("json").endpoint),
        ),
      );
    return c.body(null, 204);
  });

  app.openapi(testPush, async (c) => {
    const n = deps.notifier;
    if (!n?.vapid) return notConfigured(c);
    const sent = await sendPush(
      { db, log: n.log, vapid: n.vapid },
      userOf(c),
      {
        title: "Phone approvals are on",
        body: "Keelson will ask you here when an agent needs you.",
        url: `${n.appOrigin}/alerts/`,
        tag: "push.test",
      },
      { ttl: 60, urgency: "normal" },
    );
    return c.json({ sent }, 200);
  });

  app.openapi(readEmail, async (c) => {
    const [row] = await db
      .select()
      .from(alertEmails)
      .where(eq(alertEmails.userId, userOf(c)));
    return c.json({ address: row?.address ?? null, confirmed: row?.confirmedAt != null }, 200);
  });

  app.openapi(setEmail, async (c) => {
    const n = deps.notifier;
    if (!n) return notConfigured(c);
    const userId = userOf(c);
    const address = c.req.valid("json").address;
    // One confirmation a minute: the form cannot be used to mail someone else repeatedly.
    const fresh = await deps.kv.set(`alerts:confirm:${userId}`, "1", { NX: true, EX: 60 });
    if (fresh === null) {
      c.header("Retry-After", "60");
      return problem(c, 429, "rate-limited", "Too many requests", "Wait a minute to resend.");
    }
    await sendConfirmation(n, userId, address);
    return c.json({ address, confirmed: false }, 202);
  });

  app.openapi(removeEmail, async (c) => {
    await db.delete(alertEmails).where(eq(alertEmails.userId, userOf(c)));
    return c.body(null, 204);
  });

  app.openapi(confirm, async (c) => {
    const n = deps.notifier;
    if (!n) return notConfigured(c);
    const claims = verifyLink(n.secret, c.req.valid("json").token);
    if (claims?.p !== "confirm") return problem(c, 404, "link-invalid", "Link invalid");
    const [row] = await db
      .update(alertEmails)
      .set({ confirmedAt: new Date(), confirmNonce: null })
      .where(and(eq(alertEmails.userId, claims.u), eq(alertEmails.confirmNonce, claims.n)))
      .returning({ address: alertEmails.address });
    if (!row) {
      return problem(c, 404, "link-invalid", "Link invalid", "The link was used or replaced.");
    }
    return c.json({ address: row.address }, 200);
  });

  app.openapi(unsubscribe, async (c) => {
    const n = deps.notifier;
    if (!n) return notConfigured(c);
    const claims = verifyLink(n.secret, c.req.valid("query").token);
    if (claims?.p !== "unsubscribe") return problem(c, 404, "link-invalid", "Link invalid");
    const [row] = await db.select().from(alertEmails).where(eq(alertEmails.userId, claims.u));
    // Unsubscribing an address already gone is done all the same.
    if (row && addressHash(row.address) === claims.a) {
      await db.delete(alertEmails).where(eq(alertEmails.userId, claims.u));
    }
    return c.json({ unsubscribed: true as const }, 200);
  });

  app.openapi(trail, async (c) => {
    const rows = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.userId, userOf(c)))
      .orderBy(desc(sentEmails.createdAt))
      .limit(50);
    return c.json(
      {
        emails: rows.map((r) => ({
          id: r.id,
          address: r.address,
          event: r.event,
          subject: r.subject,
          subjectId: r.subjectId,
          logIndex: r.logIndex?.toString() ?? null,
          alibiUrl: r.alibiUrl,
          sentAt: r.sentAt?.toISOString() ?? null,
          error: r.error,
          createdAt: r.createdAt.toISOString(),
        })),
      },
      200,
    );
  });
}
