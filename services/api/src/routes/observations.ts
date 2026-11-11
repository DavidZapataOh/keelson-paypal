import { isIP } from "node:net";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { CURRENCIES, type CurrencyCode, toHex } from "@keelson/core";
import { and, channel3Observations, eq, mandates, operators } from "@keelson/db";
import { containsPii, itemLeaf, MEDIA_TYPES } from "@keelson/evidence";
import type { Deps } from "../app.ts";
import { observe } from "../channel3/observe.ts";
import { requireClient } from "../middleware/auth.ts";
import { principalKey } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";

const Hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const RATE_PER_MANDATE = 30;
const RATE_WINDOW_SEC = 60;
/** The month's 1,000 Channel3 credits are shared; one client spends at most this many a day. */
const DAILY_PER_CLIENT = 100;
const DAY_SEC = 86_400;
const USABLE = new Set(["SIGNED", "HOLD_PENDING", "ACTIVE"]);
const ITEM_TYPE = "channel3.observation" as const;

/** An `https` URL with a DNS host and no credentials: a store's product page. */
function isProductUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    isIP(host) === 0 &&
    host.includes(".")
  );
}

const Option = z.object({ name: z.string().min(1).max(128), label: z.string().min(1).max(128) });

const Body = z
  .object({
    mandateId: z.string().length(26),
    url: z
      .string()
      .max(2048)
      .refine(isProductUrl, "The URL must be https, name a DNS host and carry no credentials.")
      .openapi({ description: "The product page the agent is on." }),
    agentView: z
      .object({
        contentHash: Hex32.openapi({
          description:
            "The `content_hash` of the capture's `api.product` item the view was read from.",
        }),
        brand: z.string().min(1).max(256).optional(),
        priceMinor: z
          .string()
          .regex(/^(0|[1-9][0-9]{0,17})$/)
          .openapi({ description: "The price the agent saw, in minor units." }),
        currency: z.enum(Object.keys(CURRENCIES) as [CurrencyCode, ...CurrencyCode[]]),
        available: z.boolean(),
        selected: z.array(Option).max(16),
      })
      .openapi({ description: "What the agent saw on the page." }),
  })
  .openapi("Channel3ObservationRequest");

const Result = z.enum(["match", "mismatch", "unknown"]);
const Comparison = z
  .object({
    offerDomain: z.string().nullable(),
    variant: Result,
    price: Result,
    availability: Result,
    brand: Result,
    mismatches: z.array(z.string()),
  })
  .openapi("Channel3Comparison");

const Created = z
  .object({
    id: z.string(),
    status: z.enum(["ok", "unavailable"]).openapi({
      description:
        "`unavailable` when Channel3 did not answer in time or failed; it is stored too.",
    }),
    item: z
      .object({
        type: z.literal(ITEM_TYPE),
        mediaType: z.literal("application/json"),
        salt: z.base64().openapi({ description: "32 random bytes, base64." }),
        bytes: z.base64().openapi({ description: "The JCS observation document, base64." }),
        content_hash: Hex32,
        leaf: Hex32,
      })
      .openapi({
        description:
          "The sealed evidence item to add to the capture's items, after `har`, before `buildManifest` and `POST /v1/evidence`.",
      }),
    comparison: Comparison,
  })
  .openapi("Channel3Observation");

const problemContent = { "application/problem+json": { schema: ProblemSchema } };

const create = createRoute({
  method: "post",
  path: "/v1/observations/channel3",
  operationId: "observeChannel3",
  tags: ["evidence"],
  summary: "Observe a product through Channel3",
  description:
    "Asks Channel3 about the product page once (live fetch if its data is older than an hour, eight seconds at most), compares variant, price, availability and brand with what the agent saw, stores the observation and queues RFC 3161 tokens over its hash. Channel3 is third-party testimony: it is shown in the countersigned trace and never changes a decision.",
  middleware: [requireClient(["countersign:write"])],
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(255) }),
    body: { required: true, content: { "application/json": { schema: Body } } },
  },
  responses: {
    201: {
      description: "The observation and its sealed evidence item",
      content: { "application/json": { schema: Created } },
    },
    404: {
      description: "No such mandate of an operator this client linked",
      content: problemContent,
    },
    409: { description: "The mandate is not active", content: problemContent },
    422: { description: "The request is invalid", content: problemContent },
    429: {
      description: "Too many observations for this mandate, or today for this client",
      content: problemContent,
    },
    503: {
      description: "Channel3 is not configured, or the rate limit store is unreachable",
      content: problemContent,
    },
  },
});

const read = createRoute({
  method: "get",
  path: "/v1/observations/channel3/{id}",
  operationId: "getChannel3Observation",
  tags: ["evidence"],
  summary: "Read a Channel3 observation",
  description:
    "The stored observation document and its hash; `GET /v1/timestamps/{content_hash}` serves its RFC 3161 tokens. Only the client that asked for it may read it.",
  middleware: [requireClient(["countersign:write"])],
  request: {
    params: z.object({
      id: z
        .string()
        .length(26)
        .openapi({ param: { name: "id", in: "path" } }),
    }),
  },
  responses: {
    200: {
      description: "The observation",
      content: {
        "application/json": {
          schema: z.object({
            document: z.record(z.string(), z.unknown()).openapi({
              description:
                "The `keelson.channel3.observation/1` document; its JCS bytes hash to `content_hash`.",
            }),
            content_hash: Hex32,
          }),
        },
      },
    },
    404: { description: "No such observation", content: problemContent },
  },
});

export function registerObservations(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "kv" | "log" | "stamps" | "channel3">,
): void {
  const { db, kv, log } = deps;

  app.openapi(create, async (c) => {
    const started = performance.now();
    const channel3 = deps.channel3;
    if (!channel3) {
      return problem(
        c,
        503,
        "channel3-unconfigured",
        "Channel3 unconfigured",
        "No Channel3 API key is configured.",
      );
    }
    const body = c.req.valid("json");
    const client = c.var.principal?.subject as string;
    const page = new URL(body.url);
    page.hash = "";
    const url = page.toString();
    if (containsPii("text/plain; charset=utf-8", new TextEncoder().encode(url))) {
      return problem(
        c,
        422,
        "url-pii",
        "URL holds PII",
        "The URL holds an email address or phone number; it is sent to Channel3 and published.",
      );
    }

    // Each observation spends a Channel3 credit, so the limits fail closed.
    const now = Math.floor(Date.now() / 1000);
    const owner = principalKey({ kind: "client", subject: client });
    const minute = `rl:channel3:${owner}:${body.mandateId}:${Math.floor(now / RATE_WINDOW_SEC)}`;
    const day = `rl:channel3-day:${owner}:${Math.floor(now / DAY_SEC)}`;
    let counts: number[];
    try {
      const replies = await kv
        .multi()
        .incr(minute)
        .expire(minute, RATE_WINDOW_SEC, "NX")
        .incr(day)
        .expire(day, DAY_SEC, "NX")
        .exec();
      counts = [Number(replies[0]), Number(replies[2])];
    } catch {
      return problem(
        c,
        503,
        "dependency-unavailable",
        "Dependency unavailable",
        "The rate limit store is unreachable.",
      );
    }
    const [perMandate = 0, perDay = 0] = counts;
    if (perMandate > RATE_PER_MANDATE || perDay > DAILY_PER_CLIENT) {
      const daily = perDay > DAILY_PER_CLIENT;
      c.header("Retry-After", String(daily ? DAY_SEC - (now % DAY_SEC) : RATE_WINDOW_SEC));
      return problem(
        c,
        429,
        "rate-limited",
        "Too many requests",
        daily
          ? "Too many observations today for this client."
          : "Too many observations for this mandate.",
      );
    }

    const [mandate] = await db
      .select({ id: mandates.id, state: mandates.state, clientId: operators.clientId })
      .from(mandates)
      .innerJoin(operators, eq(operators.agentId, mandates.operatorAgentId))
      .where(eq(mandates.id, body.mandateId));
    // The same answer for an unknown mandate and another client's, so neither is disclosed.
    if (!mandate?.clientId || mandate.clientId !== c.var.principal?.subject) {
      return problem(c, 404, "not-found", "Not found");
    }
    if (!USABLE.has(mandate.state)) {
      return problem(
        c,
        409,
        "mandate-not-active",
        "Mandate not active",
        "Observations are only made for a mandate that can countersign.",
      );
    }

    const { brand, ...view } = body.agentView;
    const o = await observe(
      { db, log, stamps: deps.stamps, channel3 },
      {
        mandateId: mandate.id,
        requestedBy: client,
        url,
        agentView: {
          ...view,
          ...(brand ? { brand } : {}),
          contentHash: view.contentHash as `0x${string}`,
          url,
        },
      },
    );
    const leaf = itemLeaf({
      type: ITEM_TYPE,
      mediaType: MEDIA_TYPES[ITEM_TYPE],
      contentHash: o.contentHash,
      salt: o.salt,
    });
    const total = performance.now() - started;
    c.header(
      "Server-Timing",
      `channel3;dur=${o.lookupMs.toFixed(1)}, app;dur=${(total - o.lookupMs).toFixed(1)}`,
    );
    return c.json(
      {
        id: o.id,
        status: o.status,
        item: {
          type: ITEM_TYPE,
          mediaType: "application/json" as const,
          salt: Buffer.from(o.salt).toString("base64"),
          bytes: Buffer.from(o.bytes).toString("base64"),
          content_hash: toHex(o.contentHash),
          leaf: toHex(leaf),
        },
        comparison: o.comparison,
      },
      201,
    );
  });

  app.openapi(read, async (c) => {
    const { id } = c.req.valid("param");
    const [row] = await db
      .select({
        document: channel3Observations.document,
        contentHash: channel3Observations.contentHash,
      })
      .from(channel3Observations)
      .where(
        and(
          eq(channel3Observations.id, id),
          eq(channel3Observations.requestedBy, c.var.principal?.subject as string),
        ),
      );
    if (!row) return problem(c, 404, "not-found", "Not found");
    return c.json(
      {
        document: row.document as Record<string, unknown>,
        content_hash: toHex(row.contentHash),
      },
      200,
    );
  });
}
