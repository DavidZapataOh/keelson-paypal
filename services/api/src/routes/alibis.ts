import { createHash } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ALIBI_MEDIA_TYPE,
  type AlibiBundle,
  AlibiFormatError,
  decodeAlibi,
  encodeAlibi,
  encodeReceipt,
  receiptOf,
} from "@keelson/alibi";
import { renderAlibiPdf } from "@keelson/alibi/pdf";
import { verifyAlibi } from "@keelson/alibi/verify";
import { and, eq, evidenceBundles, mandates, purchases, user } from "@keelson/db";
import type { Context } from "hono";
import { loadAlibi, publicCopy } from "../alibi/issue.ts";
import type { Deps } from "../app.ts";
import type { Principal } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { publicDenial } from "./purchases.ts";

const Id = z
  .string()
  .regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
  .openapi({ description: "The alibi id: the purchase's ULID." });

const notFound = {
  description: "No alibi with this id that the caller may read",
  content: { "application/problem+json": { schema: ProblemSchema } },
};

const bundleRoute = createRoute({
  method: "get",
  path: "/v1/alibis/{id}",
  tags: ["alibis"],
  summary: "An alibi bundle",
  description:
    "The purchase's Alibi: its RFC 8785 bundle, readable by the mandate's user or, with `alibis:read`, by the client that uploaded the purchase's evidence; the Alibi of a live purchase, once its PayPal transaction is recorded, by anyone. Anyone else gets its public copy, whose mandate withholds the user's login id and risk data: their salted digests stay in the signed payload, so the copy verifies the same. It grows as timestamps, the capture and the on-chain anchor arrive; earlier sections never change.",
  request: { params: z.object({ id: Id }) },
  responses: {
    200: {
      description: "The bundle",
      content: { [ALIBI_MEDIA_TYPE]: { schema: z.string().openapi({ format: "binary" }) } },
    },
    304: { description: "The bundle has not changed" },
    404: notFound,
  },
});

const pdfRoute = createRoute({
  method: "get",
  path: "/v1/alibis/{id}.pdf",
  tags: ["alibis"],
  summary: "An alibi as a PDF/A-3b",
  description:
    "A one-page PDF/A-3b summary of the Alibi with a QR to its verify page and the bundle embedded as `<id>.alibi`. Same readers, and the same public copy, as the bundle.",
  request: { params: z.object({ id: Id }) },
  responses: {
    200: {
      description: "The PDF",
      content: { "application/pdf": { schema: z.string().openapi({ format: "binary" }) } },
    },
    304: { description: "The PDF has not changed" },
    404: notFound,
  },
});

const ReceiptSchema = z
  .object({
    alibi_id: z.string(),
    leaf: z.string().openapi({ description: "The leaf bytes, base64." }),
    leaf_hash: z.string().openapi({ description: "The RFC 6962 leaf hash, unpadded base64url." }),
    tlog_proof: z.string().openapi({ description: "A c2sp.org/tlog-proof@v1 with cosignatures." }),
    anchor: z.record(z.string(), z.unknown()).optional(),
    timestamps: z.array(z.object({ tsa: z.string(), token: z.string() })),
  })
  .openapi("AlibiReceipt");

const receiptRoute = createRoute({
  method: "get",
  path: "/v1/alibis/{id}/receipt",
  tags: ["alibis"],
  summary: "The public receipt of an alibi",
  description:
    "What the public log already publishes about an Alibi: its leaf, inclusion proof, anchor and timestamps. No authentication.",
  request: { params: z.object({ id: Id }) },
  responses: {
    200: { description: "The receipt", content: { "application/json": { schema: ReceiptSchema } } },
    404: notFound,
  },
});

const REFERENCE =
  "the browser verifier at https://verify.keelson.finance is the reference; this is a convenience copy";

const CheckSchema = z.object({
  id: z.string(),
  step: z.number().int(),
  status: z.enum(["pass", "fail", "undisclosed", "pending", "absent", "unreachable"]),
  reason: z.string().optional(),
  reads: z.array(z.string()).openapi({ description: "RFC 6901 pointers the check read." }),
  ms: z.number(),
  detail: z.record(z.string(), z.string()).optional(),
});

const ReportSchema = z
  .object({
    reference: z.string(),
    verdict: z.enum([
      "verified",
      "verified-unanchored",
      "verified-offline",
      "failed",
      "incomplete",
    ]),
    checks: z.array(CheckSchema),
    mode: z.enum(["2of2", "degraded"]),
    fields: z.array(z.record(z.string(), z.unknown())),
    unbound: z.array(z.object({ pointer: z.string(), value: z.unknown() })),
    changed: z.array(z.string()),
    rpc: z.object({ url: z.string(), custom: z.boolean() }).optional(),
    ms: z.number(),
  })
  .openapi("AlibiReport");

const verifyRoute = createRoute({
  method: "post",
  path: "/v1/alibis/verify",
  tags: ["alibis"],
  summary: "Verify an alibi",
  description:
    "Runs the browser verifier's algorithm on an Alibi bundle against the pinned trust roots and a public Arbitrum RPC. No authentication; the bundle is not stored.",
  request: {
    body: {
      required: true,
      content: { [ALIBI_MEDIA_TYPE]: { schema: z.string().openapi({ format: "binary" }) } },
    },
  },
  responses: {
    200: { description: "The report", content: { "application/json": { schema: ReportSchema } } },
    400: {
      description: "Not an Alibi bundle; `pointer` names the failing value",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    413: {
      description: "The body is over 1 MiB",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    415: {
      description: "The body is not an Alibi bundle's media type",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

/**
 * What the principal may read of the Alibi: all of it when it is the mandate's user or the client
 * that uploaded the evidence; its public copy when it is the Alibi of a live purchase whose PayPal
 * transaction is recorded, or of a live cart denied in one of Keelson's own test runs
 * ({@link publicDenial}); nothing otherwise.
 */
async function access(
  deps: Pick<Deps, "db" | "demoAgentId">,
  principal: Principal | undefined,
  b: AlibiBundle,
): Promise<"full" | "public" | null> {
  if (principal && (await isOwner(deps, principal, b))) return "full";
  if (b.paypal?.transaction_id !== undefined) return "public";
  const denial = publicDenial(deps.demoAgentId);
  if (!denial) return null;
  const [p] = await deps.db
    .select({ id: purchases.id })
    .from(purchases)
    .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
    .innerJoin(user, eq(user.id, mandates.userId))
    .where(and(eq(purchases.id, b.alibi_id), denial));
  return p ? "public" : null;
}

async function isOwner(deps: Pick<Deps, "db">, principal: Principal, b: AlibiBundle) {
  if (principal.kind === "user") {
    const [row] = await deps.db
      .select({ userId: mandates.userId })
      .from(purchases)
      .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
      .where(eq(purchases.id, b.alibi_id));
    return row?.userId === principal.subject;
  }
  if (!principal.scopes?.includes("alibis:read")) return false;
  const [row] = await deps.db
    .select({ uploadedBy: evidenceBundles.uploadedBy, clientId: purchases.clientId })
    .from(purchases)
    .innerJoin(
      evidenceBundles,
      eq(evidenceBundles.root, Buffer.from(b.tee.countersign.evidenceRoot.slice(2), "hex")),
    )
    .where(eq(purchases.id, b.alibi_id));
  return (
    row?.uploadedBy === principal.subject &&
    (row.clientId === null || row.clientId === principal.subject)
  );
}

const etagOf = (bundle: Uint8Array, kind: string) =>
  `"${kind}-${createHash("sha256").update(bundle).digest("hex")}"`;

/**
 * Sends a representation of the bundle. Both are functions of the bundle's bytes, so the ETag is
 * derived from them and a match answers before the PDF is rendered.
 */
async function send(
  c: Context,
  bundle: Uint8Array,
  kind: "alibi" | "pdf",
  body: () => Promise<Uint8Array> | Uint8Array,
  headers: Record<string, string> = {},
) {
  const etag = etagOf(bundle, kind);
  c.header("ETag", etag);
  c.header("Cache-Control", "private, no-cache");
  c.header("Vary", "Cookie, Authorization", { append: true });
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  c.header("Content-Type", kind === "pdf" ? "application/pdf" : ALIBI_MEDIA_TYPE);
  return c.body((await body()) as Uint8Array<ArrayBuffer>, 200);
}

export function registerAlibis(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "alibiChain" | "demoAgentId">,
): void {
  const readable = async (c: Context, id: string) => {
    const b = await loadAlibi(deps.db, id);
    const level = b && (await access(deps, c.get("principal"), b));
    return level === "full" ? b : level === "public" ? publicCopy(b as AlibiBundle) : null;
  };
  const missing = (c: Context) =>
    problem(c, 404, "alibi-not-found", "Not found", "No alibi with this id.");

  // Hono cannot route a parameter followed by a suffix, so the PDF path matches the whole segment.
  app.openAPIRegistry.registerPath(pdfRoute);
  app.get("/v1/alibis/:file{[0-7][0-9A-HJKMNP-TV-Z]{25}\\.pdf}", async (c) => {
    const id = c.req.param("file").slice(0, 26);
    const b = await readable(c, id);
    if (!b) return missing(c);
    return send(c, encodeAlibi(b), "pdf", () => renderAlibiPdf(b), {
      "Content-Disposition": `attachment; filename="${id}.pdf"`,
    });
  });

  app.openapi(bundleRoute, (async (c: Context) => {
    const { id } = c.req.param() as { id: string };
    const b = await readable(c, id);
    if (!b) return missing(c);
    const bytes = encodeAlibi(b);
    return send(c, bytes, "alibi", () => bytes);
  }) as never);

  app.openapi(verifyRoute, (async (c: Context) => {
    if (c.req.header("content-type")?.split(";")[0]?.trim() !== ALIBI_MEDIA_TYPE) {
      return problem(
        c,
        415,
        "unsupported-media-type",
        "Unsupported media type",
        `Send ${ALIBI_MEDIA_TYPE}.`,
      );
    }
    let bundle: AlibiBundle;
    try {
      bundle = decodeAlibi(new Uint8Array(await c.req.arrayBuffer()));
    } catch (err) {
      if (!(err instanceof AlibiFormatError)) throw err;
      return problem(c, 400, "alibi-malformed", "Malformed Alibi", err.message, {
        code: err.code,
        ...(err.pointer === undefined ? {} : { pointer: err.pointer }),
      });
    }
    const report = await verifyAlibi(bundle, { chain: deps.alibiChain ?? null });
    return c.json({ reference: REFERENCE, ...report }, 200);
  }) as never);

  app.openapi(receiptRoute, (async (c: Context) => {
    const { id } = c.req.param() as { id: string };
    const b = await loadAlibi(deps.db, id);
    if (!b) return missing(c);
    c.header("Cache-Control", "public, max-age=60");
    return c.body(encodeReceipt(receiptOf(b)) as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": "application/json",
    });
  }) as never);
}
