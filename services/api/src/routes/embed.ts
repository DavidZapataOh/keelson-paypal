import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { agentConnections, and, embedOrigins, eq, operators } from "@keelson/db";
import type { Context } from "hono";
import type { Deps } from "../app.ts";
import { hashDeviceCode, REQUEST_TTL_SEC } from "../connections.ts";
import {
  clientEmbedOrigins,
  EMBED_TOKEN_TTL_SEC,
  type Embed,
  httpsOrigin,
  mintEmbed,
  redeemEmbed,
  sessionEmbed,
  sessionUser,
} from "../embed.ts";
import { requireClient } from "../middleware/auth.ts";
import type { Principal } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { ConnectionView, connectionView, denyRequest } from "./connections.ts";
import { EmbedSigner, signerOf } from "./embed-signing.ts";

const problemContent = { "application/problem+json": { schema: ProblemSchema } };

/** The header a frame sends its embed session in; never a cookie, which a frame may not get. */
const EMBED_SESSION_HEADER = "keelson-embed";

/** At most this many origins per client. */
const MAX_ORIGINS = 5;

const Origins = z
  .object({
    origins: z
      .array(z.string().max(255))
      .min(1)
      .max(MAX_ORIGINS)
      .openapi({ example: ["https://agents.example.com"] }),
  })
  .openapi("EmbedOrigins");

const EmbedView = z
  .object({
    ref: z.string(),
    /** The agent platform the approval is framed in; the user sees it. */
    origin: z.string(),
    request: ConnectionView,
    /** Who the frame signs for, once the user signed in here or linked a Keelson window. */
    signer: EmbedSigner.nullable(),
    /**
     * The number the Keelson window asks for before it signs, while it is unmatched. Signing in
     * the frame needs none.
     */
    matchNumber: z.int().nullable(),
  })
  .openapi("EmbedRequest");

const setOrigins = createRoute({
  method: "put",
  path: "/v1/embed/origins",
  tags: ["embed"],
  summary: "Set the origins that may frame approvals",
  description:
    "Replaces the https origins this client's agent platform may embed Keelson's approval in. Each becomes the page's `frame-ancestors` for that client's requests, and the only origin the frame talks to with `postMessage`.",
  middleware: [requireClient(["countersign:write"])],
  request: {
    body: { required: true, content: { "application/json": { schema: Origins } } },
  },
  responses: {
    200: {
      description: "The origins now allowed",
      content: { "application/json": { schema: Origins } },
    },
    401: { description: "No valid access token", content: problemContent },
    422: { description: "An origin is not a bare https origin", content: problemContent },
  },
});

const create = createRoute({
  method: "post",
  path: "/v1/connections/embed",
  tags: ["embed"],
  summary: "Embed the approval of a request",
  description:
    "For a pending request this client made, a URL to frame in the agent platform's page at `origin`, one of the client's embed origins. The URL's fragment carries a single-use token the frame redeems within five minutes; mint another to frame it again. The user approves in a Keelson window the frame opens, with a passkey; poll `POST /v1/connections/token` as usual for the answer.",
  middleware: [requireClient(["countersign:write"])],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ device_code: z.string().max(256), origin: z.string().max(255) }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Frame `url`; it opens to the request",
      content: {
        "application/json": {
          schema: z
            .object({ url: z.string(), ref: z.string(), expires_in: z.int() })
            .openapi("EmbedUrl"),
        },
      },
    },
    401: { description: "No valid access token", content: problemContent },
    403: { description: "The origin is not one of this client's", content: problemContent },
    404: { description: "No pending request with this device code", content: problemContent },
  },
});

const session = createRoute({
  method: "post",
  path: "/v1/embed/sessions",
  tags: ["embed"],
  summary: "Open the embedded approval",
  description:
    "The frame spends its token, once, for a session it keeps in memory and sends in `Keelson-Embed`. No cookie is read or set.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ token: z.string().max(64) }) } },
    },
  },
  responses: {
    201: {
      description: "The session and the request",
      content: {
        "application/json": {
          schema: z.object({ session: z.string(), embed: EmbedView }).openapi("EmbedSession"),
        },
      },
    },
    401: { description: "The token is unknown, spent or expired", content: problemContent },
  },
});

const sessionHeaders = z.object({ [EMBED_SESSION_HEADER]: z.string().max(64).optional() });

const read = createRoute({
  method: "get",
  path: "/v1/embed/request",
  tags: ["embed"],
  summary: "Read the embedded request",
  request: { headers: sessionHeaders },
  responses: {
    200: { description: "The request", content: { "application/json": { schema: EmbedView } } },
    401: { description: "No live embed session", content: problemContent },
  },
});

const deny = createRoute({
  method: "post",
  path: "/v1/embed/deny",
  tags: ["embed"],
  summary: "Decline the embedded request",
  request: {
    headers: sessionHeaders,
  },
  responses: {
    200: { description: "Declined", content: { "application/json": { schema: EmbedView } } },
    401: { description: "No live embed session", content: problemContent },
    409: { description: "The request is no longer pending", content: problemContent },
  },
});

export function registerEmbed(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "kv" | "log" | "authBaseUrl">,
): void {
  const { db, kv } = deps;

  const view = async (embed: Embed, session?: string) => {
    const [row] = await db
      .select({ request: agentConnections, operator: operators })
      .from(agentConnections)
      .innerJoin(operators, eq(operators.agentId, agentConnections.operatorAgentId))
      .where(eq(agentConnections.id, embed.connectionId));
    if (!row) return undefined;
    return {
      row,
      view: {
        ref: embed.ref,
        origin: embed.origin,
        request: await connectionView(db, row.request, row.operator),
        matchNumber: row.request.matchedAt === null ? row.request.matchNumber : null,
        signer: await (async () => {
          const bound = session ? await sessionUser(kv, session) : undefined;
          return bound ? signerOf(db, bound) : null;
        })(),
      },
    };
  };
  const noSession = (c: Context) =>
    problem(c, 401, "embed-session-invalid", "No embed session", "Open the embed again.");

  app.openapi(setOrigins, async (c) => {
    const clientId = (c.get("principal") as Principal).subject;
    const input = c.req.valid("json").origins;
    const origins = [...new Set(input.map(httpsOrigin))];
    if (origins.some((o) => o === undefined)) {
      return problem(
        c,
        422,
        "invalid-origin",
        "Invalid origin",
        "Each origin is https://host[:port], with no path.",
      );
    }
    await db.transaction(async (tx) => {
      await tx.delete(embedOrigins).where(eq(embedOrigins.clientId, clientId));
      await tx
        .insert(embedOrigins)
        .values(origins.map((origin) => ({ clientId, origin: origin as string })));
    });
    return c.json({ origins: origins as string[] }, 200);
  });

  app.openapi(create, async (c) => {
    const clientId = (c.get("principal") as Principal).subject;
    const body = c.req.valid("json");
    const [request] = await db
      .select()
      .from(agentConnections)
      .where(
        and(
          eq(agentConnections.deviceCodeHash, hashDeviceCode(body.device_code)),
          eq(agentConnections.clientId, clientId),
          eq(agentConnections.state, "PENDING"),
        ),
      );
    if (!request || request.expiresAt.getTime() <= Date.now()) {
      return problem(c, 404, "not-found", "Not found", "No pending request with this device code.");
    }
    const origin = httpsOrigin(body.origin);
    if (!origin || !(await clientEmbedOrigins(db, clientId)).includes(origin)) {
      return problem(
        c,
        403,
        "origin-not-allowed",
        "Origin not allowed",
        "Register the origin with PUT /v1/embed/origins first.",
      );
    }
    // Readable until the agent can no longer collect the answer, a request lifetime after expiry.
    const liveUntil = new Date(request.expiresAt.getTime() + REQUEST_TTL_SEC * 1000);
    const { ref, token } = await mintEmbed(
      kv,
      { connectionId: request.id, clientId, origin },
      liveUntil,
    );
    const url = new URL("/embed/approve", deps.authBaseUrl ?? c.req.url);
    url.search = new URLSearchParams({ r: ref }).toString();
    // The token rides in the fragment, which no server or referrer ever sees.
    url.hash = new URLSearchParams({ t: token }).toString();
    return c.json({ url: url.toString(), ref, expires_in: EMBED_TOKEN_TTL_SEC }, 201, {
      "cache-control": "no-store",
    });
  });

  app.openapi(session, async (c) => {
    const opened = await redeemEmbed(kv, c.req.valid("json").token);
    const found = opened && (await view(opened.embed));
    if (!opened || !found) {
      return problem(
        c,
        401,
        "embed-token-invalid",
        "Embed token invalid",
        "This approval was already opened or has expired. Ask the platform to show it again.",
      );
    }
    return c.json({ session: opened.session, embed: found.view }, 201, {
      "cache-control": "no-store",
    });
  });

  app.openapi(read, async (c) => {
    const session = c.req.header(EMBED_SESSION_HEADER);
    const embed = await sessionEmbed(kv, session);
    const found = embed && (await view(embed, session));
    if (!found) return noSession(c);
    return c.json(found.view, 200, { "cache-control": "no-store" });
  });

  app.openapi(deny, async (c) => {
    const embed = await sessionEmbed(kv, c.req.header(EMBED_SESSION_HEADER));
    const found = embed && (await view(embed));
    if (!found) return noSession(c);
    const { request } = found.row;
    if (request.expiresAt.getTime() <= Date.now() || !(await denyRequest(deps, request, null))) {
      return problem(c, 409, "connection-closed", "Request closed", "It was already answered.");
    }
    const after = await view(embed);
    return c.json((after ?? found).view, 200);
  });
}
