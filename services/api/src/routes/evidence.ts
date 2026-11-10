import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { fromHex, sha256, toHex } from "@keelson/core";
import {
  and,
  asc,
  eq,
  evidenceAccess,
  evidenceBundles,
  evidenceItems,
  mandates,
  operators,
  sql,
} from "@keelson/db";
import {
  buildManifest,
  containsPii,
  type Hex32 as Hex32Type,
  ITEM_TYPES,
  type ItemKind,
  inclusionPath,
  itemLeaf,
  itemRank,
  type Manifest,
  MEDIA_TYPES,
  ORIGINAL_MEDIA_TYPE,
  type SealedItem,
} from "@keelson/evidence";
import { Decrypter } from "age-encryption";
import type { Deps } from "../app.ts";
import { requireClient } from "../middleware/auth.ts";
import { principalKey } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";

const Hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const MAX_ITEMS = 2 * ITEM_TYPES.length;
/**
 * A mandate countersigns a bounded number of purchases, so it needs a bounded number of bundles.
 * @internal
 */
export const EVIDENCE_BUNDLES_PER_MANDATE = 64;
const RATE_PER_MANDATE = 120;
const RATE_WINDOW_SEC = 60;
const USABLE = new Set(["SIGNED", "HOLD_PENDING", "ACTIVE"]);

const ManifestSchema = z
  .object({
    v: z.literal("keelson.manifest/1"),
    root: Hex32,
    items: z
      .array(
        z.object({
          type: z.string(),
          media_type: z.string(),
          leaf: Hex32.openapi({
            description:
              '`SHA-256(0x00 ‖ "keelson/evidence-item/v1" ‖ salt ‖ type ‖ 0x00 ‖ media_type ‖ 0x00 ‖ content_hash)`.',
          }),
        }),
      )
      .min(1)
      .max(MAX_ITEMS),
  })
  .openapi("EvidenceManifest", {
    description:
      "Type, media type and salted leaf of every item, in order; `root` is the RFC 6962 tree hash of the leaves and the `evidenceRoot`. Content hashes and salts are only given in a disclosure.",
  });

const Upload = z
  .object({
    mandateId: z.string().length(26),
    manifest: ManifestSchema,
    items: z
      .array(
        z.object({
          type: z.string().max(64),
          mediaType: z.string().max(128),
          salt: z.base64().openapi({ description: "32 random bytes, base64." }),
          bytes: z.base64().openapi({ description: "The item bytes, base64." }),
        }),
      )
      .min(1)
      .max(MAX_ITEMS),
  })
  .openapi("EvidenceUpload");

const Disclosure = z
  .object({
    index: z.number().int(),
    type: z.string(),
    media_type: z.string(),
    content_hash: Hex32,
    salt: Hex32,
    path: z.array(Hex32).openapi({ description: "The RFC 9162 inclusion proof, leaf first." }),
    size: z.number().int(),
  })
  .openapi("EvidenceDisclosure");

const problemContent = { "application/problem+json": { schema: ProblemSchema } };
const RootParam = z.object({ root: Hex32.openapi({ param: { name: "root", in: "path" } }) });

const upload = createRoute({
  method: "post",
  path: "/v1/evidence",
  tags: ["evidence"],
  summary: "Store sealed evidence",
  description:
    "Stores what the agent saw at decision time for an active mandate of an operator this client linked. The manifest is rebuilt from the items and must match, every item has its own salt, no public item may still hold an email address or phone number, and every `.original` must open with the evidence identity. A countersign may only bind a stored root, once.",
  middleware: [requireClient(["evidence:write"])],
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(255) }),
    body: { required: true, content: { "application/json": { schema: Upload } } },
  },
  responses: {
    201: {
      description: "Stored",
      content: { "application/json": { schema: z.object({ evidenceRoot: Hex32 }) } },
    },
    404: {
      description: "No such mandate of an operator this client linked",
      content: problemContent,
    },
    409: {
      description:
        "The mandate is not active, holds the most bundles it may, or the root is stored for another mandate",
      content: problemContent,
    },
    413: { description: "The bundle is larger than 16 MiB", content: problemContent },
    422: {
      description:
        "The items do not build the manifest, a public item holds PII, or an original does not open",
      content: problemContent,
    },
    429: { description: "Too many uploads for this mandate", content: problemContent },
  },
});

const manifestRoute = createRoute({
  method: "get",
  path: "/v1/evidence/{root}",
  tags: ["evidence"],
  summary: "Read an evidence manifest",
  description: "The public manifest of a stored bundle: salted leaves only.",
  request: { params: RootParam },
  responses: {
    200: {
      description: "The manifest",
      content: { "application/json": { schema: ManifestSchema } },
    },
    404: { description: "No such bundle", content: problemContent },
  },
});

const itemRoute = createRoute({
  method: "get",
  path: "/v1/evidence/{root}/items/{index}",
  tags: ["evidence"],
  summary: "Disclose one evidence item",
  description:
    "One item with its content hash, salt and inclusion proof, for an arbiter. Every disclosure is recorded with its `reason`. An `.original` item stays age ciphertext unless `decrypt=1` is sent with the `evidence:decrypt` scope.",
  middleware: [requireClient(["evidence:disclose"])],
  request: {
    params: RootParam.extend({
      index: z.coerce
        .number()
        .int()
        .min(0)
        .max(MAX_ITEMS - 1)
        .openapi({ param: { name: "index", in: "path", required: true } }),
    }),
    query: z.object({
      reason: z
        .string()
        .min(1)
        .max(256)
        .openapi({ description: "Why the item is opened, such as the dispute it serves." }),
      decrypt: z.enum(["1"]).optional(),
    }),
  },
  responses: {
    200: {
      description: "The item and its disclosure",
      content: {
        "application/json": {
          schema: z
            .object({ disclosure: Disclosure, bytes: z.base64() })
            .openapi("DisclosedEvidence"),
        },
      },
    },
    403: { description: "Decrypting needs the `evidence:decrypt` scope", content: problemContent },
    404: { description: "No such bundle or item", content: problemContent },
    422: {
      description: "The item is not an `.original`, or it does not open with the evidence identity",
      content: problemContent,
    },
    503: { description: "The evidence identity is not configured", content: problemContent },
  },
});

function sameManifest(a: Manifest, b: z.infer<typeof ManifestSchema>): boolean {
  return (
    a.root === b.root &&
    a.items.length === b.items.length &&
    a.items.every(
      (x, k) =>
        x.type === b.items[k]?.type &&
        x.media_type === b.items[k]?.media_type &&
        x.leaf === b.items[k]?.leaf,
    )
  );
}

function expectedMediaType(type: string): string | undefined {
  if (type.endsWith(".original")) return ORIGINAL_MEDIA_TYPE;
  return MEDIA_TYPES[type as keyof typeof MEDIA_TYPES];
}

async function opens(identity: string, ciphertext: Uint8Array): Promise<Uint8Array | null> {
  const d = new Decrypter();
  d.addIdentity(identity);
  try {
    return await d.decrypt(ciphertext);
  } catch {
    return null;
  }
}

export function registerEvidence(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "kv" | "log" | "evidenceIdentity">,
): void {
  const { db, kv, log } = deps;

  app.openapi(upload, async (c) => {
    const body = c.req.valid("json");
    const client = c.var.principal?.subject as string;

    const [mandate] = await db
      .select({ id: mandates.id, state: mandates.state, clientId: operators.clientId })
      .from(mandates)
      .innerJoin(operators, eq(operators.agentId, mandates.operatorAgentId))
      .where(eq(mandates.id, body.mandateId));
    // The same answer for an unknown mandate and another client's, so neither is disclosed.
    if (!mandate?.clientId || mandate.clientId !== client) {
      return problem(c, 404, "not-found", "Not found");
    }
    if (!USABLE.has(mandate.state)) {
      return problem(
        c,
        409,
        "mandate-not-active",
        "Mandate not active",
        "Evidence is only stored for a mandate that can countersign.",
      );
    }

    const window = Math.floor(Date.now() / 1000 / RATE_WINDOW_SEC);
    const key = `rl:evidence:${principalKey({ kind: "client", subject: client })}:${mandate.id}:${window}`;
    try {
      const [count] = await kv.multi().incr(key).expire(key, RATE_WINDOW_SEC, "NX").exec();
      if (Number(count) > RATE_PER_MANDATE) {
        c.header("Retry-After", String(RATE_WINDOW_SEC));
        return problem(
          c,
          429,
          "rate-limited",
          "Too many requests",
          "Too many uploads for this mandate.",
        );
      }
    } catch {
      // The bundle cap below still bounds what a mandate can hold.
    }

    const items: SealedItem[] = [];
    for (const item of body.items) {
      const salt = Uint8Array.from(Buffer.from(item.salt, "base64"));
      if (
        salt.length !== 32 ||
        itemRank(item.type) < 0 ||
        expectedMediaType(item.type) !== item.mediaType
      ) {
        return problem(
          c,
          422,
          "invalid-evidence",
          "Invalid evidence",
          `Item ${item.type} is malformed.`,
        );
      }
      items.push({
        type: item.type as ItemKind,
        mediaType: item.mediaType,
        salt,
        bytes: Uint8Array.from(Buffer.from(item.bytes, "base64")),
      });
    }
    let rebuilt: Manifest;
    try {
      rebuilt = buildManifest(items);
    } catch (err) {
      const detail = err instanceof Error ? err.message : undefined;
      return problem(c, 422, "invalid-evidence", "Invalid evidence", detail);
    }
    if (!sameManifest(rebuilt, body.manifest)) {
      return problem(
        c,
        422,
        "evidence-root-mismatch",
        "Evidence root mismatch",
        "The items do not build the manifest that was sent.",
      );
    }
    const leaking = items.find(
      (i) => !i.type.endsWith(".original") && containsPii(i.mediaType, i.bytes),
    );
    if (leaking) {
      return problem(
        c,
        422,
        "evidence-pii",
        "Evidence holds PII",
        `The public item ${leaking.type} holds an email address or phone number.`,
      );
    }
    if (deps.evidenceIdentity) {
      for (const item of items.filter((i) => i.type.endsWith(".original"))) {
        if (!(await opens(deps.evidenceIdentity, item.bytes))) {
          return problem(
            c,
            422,
            "evidence-undecryptable",
            "Evidence does not open",
            `The item ${item.type} is not sealed to the evidence recipient.`,
          );
        }
      }
    }

    const root = Buffer.from(fromHex(rebuilt.root));
    const outcome = await db.transaction(async (tx) => {
      // Serializes uploads for one mandate so the cap holds under concurrency.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${mandate.id}))`);
      const [existing] = await tx
        .select({ mandateId: evidenceBundles.mandateId })
        .from(evidenceBundles)
        .where(eq(evidenceBundles.root, root));
      if (existing) return existing.mandateId === mandate.id ? "stored" : "other-mandate";
      const [held] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(evidenceBundles)
        .where(eq(evidenceBundles.mandateId, mandate.id));
      if ((held?.n ?? 0) >= EVIDENCE_BUNDLES_PER_MANDATE) return "full";
      await tx
        .insert(evidenceBundles)
        .values({ root, mandateId: mandate.id, manifest: rebuilt, uploadedBy: client });
      await tx.insert(evidenceItems).values(
        items.map((item, index) => ({
          root,
          index,
          type: item.type,
          mediaType: item.mediaType,
          contentHash: Buffer.from(sha256(item.bytes)),
          salt: Buffer.from(item.salt),
          bytes: Buffer.from(item.bytes),
        })),
      );
      return "stored";
    });
    if (outcome === "other-mandate") {
      return problem(
        c,
        409,
        "evidence-exists",
        "Evidence exists",
        "The root is stored for another mandate.",
      );
    }
    if (outcome === "full") {
      return problem(
        c,
        409,
        "evidence-limit",
        "Evidence limit reached",
        `A mandate holds at most ${EVIDENCE_BUNDLES_PER_MANDATE} evidence bundles.`,
      );
    }
    log.info({ root: rebuilt.root, mandateId: mandate.id, client }, "evidence stored");
    return c.json({ evidenceRoot: rebuilt.root }, 201);
  });

  app.openapi(manifestRoute, async (c) => {
    const { root } = c.req.valid("param");
    const [row] = await db
      .select({ manifest: evidenceBundles.manifest })
      .from(evidenceBundles)
      .where(eq(evidenceBundles.root, Buffer.from(fromHex(root))));
    if (!row) return problem(c, 404, "not-found", "Not found");
    return c.json(row.manifest as z.infer<typeof ManifestSchema>, 200);
  });

  app.openapi(itemRoute, async (c) => {
    const { root, index } = c.req.valid("param");
    const { decrypt, reason } = c.req.valid("query");
    const client = c.var.principal?.subject as string;
    if (decrypt && !c.var.principal?.scopes?.includes("evidence:decrypt")) {
      return problem(
        c,
        403,
        "insufficient-scope",
        "Insufficient scope",
        "Decrypting needs evidence:decrypt.",
      );
    }
    const key = Buffer.from(fromHex(root));
    const rows = await db
      .select({
        index: evidenceItems.index,
        type: evidenceItems.type,
        mediaType: evidenceItems.mediaType,
        contentHash: evidenceItems.contentHash,
        salt: evidenceItems.salt,
      })
      .from(evidenceItems)
      .where(eq(evidenceItems.root, key))
      .orderBy(asc(evidenceItems.index));
    const row = rows[index];
    if (!row) return problem(c, 404, "not-found", "Not found");
    if (decrypt && !row.type.endsWith(".original")) {
      return problem(c, 422, "not-sealed", "Not sealed", "Only an .original item is encrypted.");
    }
    if (decrypt && !deps.evidenceIdentity) {
      return problem(c, 503, "evidence-identity-unavailable", "Evidence identity unavailable");
    }
    const [item] = await db
      .select({ bytes: evidenceItems.bytes })
      .from(evidenceItems)
      .where(and(eq(evidenceItems.root, key), eq(evidenceItems.index, index)));
    let bytes: Uint8Array = new Uint8Array(item?.bytes ?? []);
    if (decrypt) {
      const plain = await opens(deps.evidenceIdentity as string, bytes);
      if (!plain) {
        return problem(
          c,
          422,
          "evidence-undecryptable",
          "Evidence does not open",
          "The item does not open with the evidence identity.",
        );
      }
      bytes = plain;
    }

    const action = decrypt ? "decrypt" : "disclose";
    await db.insert(evidenceAccess).values({ root: key, index, client, action, reason });
    log.info({ root, index, client, action, reason }, "evidence opened");

    const leaves = rows.map((r) =>
      itemLeaf({
        type: r.type as ItemKind,
        mediaType: r.mediaType,
        contentHash: r.contentHash,
        salt: r.salt,
      }),
    );
    return c.json(
      {
        disclosure: {
          index,
          type: row.type,
          media_type: row.mediaType,
          content_hash: toHex(row.contentHash) as Hex32Type,
          salt: toHex(row.salt) as Hex32Type,
          path: inclusionPath(leaves, index).map((p) => toHex(p) as Hex32Type),
          size: rows.length,
        },
        bytes: Buffer.from(bytes).toString("base64"),
      },
      200,
    );
  });
}
