import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { TsaId } from "@keelson/timestamp";
import type { Deps } from "../app.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { rowsFor, storedStamps } from "../timestamps/queue.ts";

const TsaSchema = z.enum(["digicert", "sigstore", "freetsa", "sectigo"]);

const StampSchema = z
  .object({
    tsa: TsaSchema,
    role: z.enum(["primary", "fallback"]),
    token: z.string().openapi({ description: "The DER `TimeStampToken`, base64." }),
    genTime: z.string().openapi({ description: "The token's `genTime`, RFC 3339 UTC." }),
    serial: z.string().openapi({ description: "The token's serial number, hex." }),
  })
  .openapi("Timestamp");

const route = createRoute({
  method: "get",
  path: "/v1/timestamps/{hash}",
  operationId: "getTimestamps",
  tags: ["timestamps"],
  summary: "RFC 3161 timestamps of a hash",
  description:
    "The RFC 3161 tokens two independent TSAs issued over a log leaf hash (or another stamped hash). Each token's message imprint is the hash itself, so `openssl ts -verify -digest <hash>` checks it.",
  request: {
    params: z.object({
      hash: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .openapi({ description: "The SHA-256 hash, 64 lowercase hex digits." }),
    }),
  },
  responses: {
    200: {
      description: "The tokens issued so far and the TSAs still pending",
      content: {
        "application/json": {
          schema: z.object({
            hash: z.string(),
            stamps: z.array(StampSchema),
            pending: z.array(TsaSchema),
          }),
        },
      },
    },
    404: {
      description: "The hash was never queued",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

/** A hash is complete once each primary, or the fallback that replaced it, has a token. */
const PAIRS: [TsaId, TsaId][] = [
  ["digicert", "freetsa"],
  ["sigstore", "sectigo"],
];

export function registerTimestamps(app: OpenAPIHono, deps: Pick<Deps, "db">): void {
  app.openapi(route, async (c) => {
    const { hash } = c.req.valid("param");
    const key = Buffer.from(hash, "hex");
    const rows = await rowsFor(deps.db, key);
    if (rows.length === 0) {
      return problem(c, 404, "timestamps-not-found", "Not found", "No timestamp for this hash.");
    }
    const stamps = storedStamps(rows);
    const pending = rows
      .filter((r) => r.status === "pending" || r.status === "inflight")
      .map((r) => r.tsa as TsaId)
      .sort();
    const stampedBy = new Set(stamps.map((s) => s.tsa));
    const complete = PAIRS.every((pair) => pair.some((tsa) => stampedBy.has(tsa)));
    c.header("Cache-Control", complete ? "public, max-age=31536000, immutable" : "no-store");
    return c.json({ hash, stamps, pending }, 200);
  });
}
