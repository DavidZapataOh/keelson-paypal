import { createHash } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ALIBI_MEDIA_TYPE,
  type AlibiBundle,
  encodeAlibi,
  encodeReceipt,
  receiptOf,
} from "@keelson/alibi";
import { renderAlibiPdf } from "@keelson/alibi/pdf";
import { eq, evidenceBundles, mandates, purchases } from "@keelson/db";
import type { Context } from "hono";
import { loadAlibi } from "../alibi/issue.ts";
import type { Deps } from "../app.ts";
import type { Principal } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";

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
    "The purchase's Alibi: its RFC 8785 bundle, readable by the mandate's user or, with `alibis:read`, by the client that uploaded the purchase's evidence. It grows as timestamps, the capture and the on-chain anchor arrive; earlier sections never change.",
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
    "A one-page PDF/A-3b summary of the Alibi with a QR to its verify page and the bundle embedded as `<id>.alibi`. Same readers as the bundle.",
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

/** Whether the principal is the mandate's user or the client that uploaded the evidence. */
async function mayRead(deps: Pick<Deps, "db">, principal: Principal | undefined, b: AlibiBundle) {
  if (!principal) return false;
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
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  c.header("Content-Type", kind === "pdf" ? "application/pdf" : ALIBI_MEDIA_TYPE);
  return c.body((await body()) as Uint8Array<ArrayBuffer>, 200);
}

export function registerAlibis(app: OpenAPIHono, deps: Pick<Deps, "db">): void {
  const readable = async (c: Context, id: string) => {
    const b = await loadAlibi(deps.db, id);
    return b && (await mayRead(deps, c.get("principal"), b)) ? b : null;
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
