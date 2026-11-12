import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ALIBI_MEDIA_TYPE_V2,
  type AlibiBundle,
  type AlibiBundleV2,
  encodeAny,
  registeredOf,
} from "@keelson/alibi";
import {
  BindingError,
  type EcPublicJwk,
  type ExportKeys,
  ExportRefused,
  type ExportSigner,
  exportOne,
  type Format,
  jwks,
  type PurchaseFacts,
  purchaseFacts,
  refOf,
} from "@keelson/interop";
import { renderEvidencePackPdf } from "@keelson/interop/visa-pdf";
import { parseStatementLeaf } from "@keelson/log";
import type { Context } from "hono";
import { calculateJwkThumbprint, type JWK } from "jose";
import { loadAlibi, publicCopy } from "../alibi/issue.ts";
import type { Deps } from "../app.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { type LegClient, LegError } from "../tee/client.ts";
import { access } from "./alibis.ts";

const FORMATS = ["ap2", "vi", "ucp", "acp", "tap", "visa", "visa.pdf"] as const;
/** The hosted agent's key directory, which its RFC 9421 `Signature-Agent` names. */
const SIGNATURE_AGENT = "https://api.keelson.finance";

const exportRoute = createRoute({
  method: "get",
  path: "/v1/alibis/{id}/exports/{format}",
  tags: ["Alibis"],
  summary: "An Alibi in an agentic-commerce standard",
  description:
    "The purchase as AP2 v0.2, Mastercard Verifiable Intent v0.1, UCP 2026-08-25, ACP 2026-04-17, a Visa TAP / Web Bot Auth request, or the Visa 4.1.23 / Compelling Evidence 3.0 evidence pack (`visa`, or `visa.pdf`). Each carries the purchase's SCITT transparent statement and is signed by leg A's attested issuer key. The owner gets the full copy; anyone else what the Alibi shows them.",
  request: {
    params: z.object({
      id: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
      format: z.enum(FORMATS),
    }),
  },
  responses: {
    200: { description: "The export." },
    404: {
      description: "No Alibi with this id, or not readable.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description: "This format cannot state this purchase.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    503: {
      description: "The enclave issuer is not available.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const isV2 = (b: AlibiBundle | AlibiBundleV2): b is AlibiBundleV2 => b.type === ALIBI_MEDIA_TYPE_V2;

/** Whether a v2 Alibi's statement is a purchase's, the only kind an export states. */
function isPurchase(b: AlibiBundleV2): boolean {
  try {
    return parseStatementLeaf(registeredOf(b)).kind === "purchase";
  } catch {
    return false;
  }
}

/** Serves Alibi exports and the keys that verify them. */
export function registerExports(app: OpenAPIHono, deps: Deps): void {
  const refused = (c: Context, reason: string, status: 409 | 503 = 409) =>
    problem(
      c,
      status,
      "export-refused",
      "Export refused",
      `This export is not available: ${reason}.`,
      { reason },
    );

  app.openapi(exportRoute, (async (c: Context) => {
    const { id, format } = c.req.param() as { id: string; format: (typeof FORMATS)[number] };
    if (!FORMATS.includes(format)) return problem(c, 404, "not-found", "Not found");
    const stored = await loadAlibi(deps.db, id);
    if (stored && isV2(stored) && !isPurchase(stored)) return refused(c, "not_a_purchase");
    const level = stored && (await access(deps, c.get("principal"), stored));
    if (!stored || !level)
      return problem(c, 404, "alibi-not-found", "Not found", "No alibi with this id.");
    // Leg A signs only over a purchase statement; a v1 Alibi's bridge statement is not one.
    if (!isV2(stored)) return refused(c, "v1_alibi");
    const v2 = stored;
    const issuer = await issuerOf(deps);
    if (!issuer) return refused(c, "signer_unavailable", 503);
    const served = level === "full" ? stored : publicCopy(stored);
    const base = format === "visa.pdf" ? "visa" : format;
    try {
      const f = purchaseFacts(served);
      const keys = exportKeysFor(level, deps, issuer, f);
      const x = await exportOne(base as Format, f, refOf(v2), keys, {
        now: Math.floor(Date.now() / 1000),
        bundle: served,
      });
      if (format === "visa.pdf") {
        const pdf = await renderEvidencePackPdf(x as never, encodeAny(served));
        return c.body(pdf as Uint8Array<ArrayBuffer>, 200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${id}.visa-evidence.pdf"`,
        });
      }
      return c.body(JSON.stringify(x), 200, {
        "Content-Type": `application/vnd.keelson.${format}+json`,
        "Content-Disposition": `attachment; filename="${id}.${format}.json"`,
      });
    } catch (e) {
      if (e instanceof ExportRefused) {
        return refused(c, e.reason, e.reason === "signer_unavailable" ? 503 : 409);
      }
      if (e instanceof BindingError) {
        deps.log.error({ err: e, id, format }, "the issuer refused an export binding");
        return problem(
          c,
          502,
          "export-binding",
          "Export not signed",
          "The enclave issuer refused this export.",
        );
      }
      throw e;
    }
  }) as never);

  app.get("/.well-known/jwks.json", async (c) => {
    const issuer = await issuerOf(deps).catch(() => undefined);
    const keys = [issuer?.jwk, deps.hostedAgent?.jwk].filter((k) => k !== undefined);
    c.header("Cache-Control", "public, max-age=300");
    return c.json(jwks(...keys));
  });

  app.get("/.well-known/http-message-signatures-directory", (c) => {
    if (!deps.agentHttpKey) return problem(c, 404, "not-found", "Not found");
    c.header("Cache-Control", "public, max-age=300");
    return c.body(JSON.stringify({ keys: [deps.agentHttpKey.jwk] }), 200, {
      "Content-Type": "application/http-message-signatures-directory+json",
    });
  });
}

const BINDING_CODES = new Set([
  "export.facts",
  "export.binding",
  "export.typ",
  "export.statement",
  "export.receipt",
  "export.profile",
]);

/** The enclave issuer over leg A's `POST /v1/exports/sign`, its refusals mapped to theirs. */
export function legExportSigner(
  leg: Pick<LegClient, "signExport">,
  jwk: EcPublicJwk,
): ExportSigner {
  return {
    jwk,
    async sign(typ, payload, statement) {
      try {
        return (await leg.signExport({ typ, payload, statement })).jws;
      } catch (e) {
        if (!(e instanceof LegError)) throw e;
        if (e.code && BINDING_CODES.has(e.code)) {
          throw new BindingError(e.code as BindingError["code"]);
        }
        // No route, no log or issuer on the leg, or no answer: nothing can be signed now.
        if (e.kind !== "problem" || e.status === 404 || e.code === "export.leg") {
          throw new ExportRefused("signer_unavailable");
        }
        throw e;
      }
    },
  };
}

/**
 * The keys an export is signed with. Only the owner's copy is closed by the hosted agent or signed
 * with its HTTP key: anyone else would otherwise mint fresh agent credentials for any public Alibi.
 */
export function exportKeysFor(
  level: "full" | "public",
  deps: Pick<Deps, "hostedAgent" | "agentHttpKey">,
  issuer: ExportSigner,
  f: PurchaseFacts,
): ExportKeys {
  if (level !== "full") return { issuer };
  const cnf = f.mandate.agent?.cnf?.jwk as { x?: string; y?: string } | undefined;
  const agent =
    deps.hostedAgent && cnf?.x === deps.hostedAgent.jwk.x && cnf?.y === deps.hostedAgent.jwk.y
      ? deps.hostedAgent
      : undefined;
  return {
    issuer,
    ...(agent ? { agent } : {}),
    ...(deps.agentHttpKey ? { agentHttp: deps.agentHttpKey, signatureAgent: SIGNATURE_AGENT } : {}),
  };
}

/**
 * Leg A's issuer, its public key read from the leg's health and read again once `ttlMs` has passed,
 * so a rotation is followed without a restart.
 */
export function legIssuer(
  leg: Pick<LegClient, "health" | "signExport">,
  o: { ttlMs?: number; clock?: () => number } = {},
): () => Promise<ExportSigner | undefined> {
  const ttl = o.ttlMs ?? 60_000;
  const clock = o.clock ?? Date.now;
  let cached: { at: number; signer: ExportSigner | undefined } | undefined;
  return async () => {
    if (cached && clock() - cached.at < ttl) return cached.signer;
    const jwk = (await leg.health().catch(() => undefined))?.issuer as JWK | undefined | null;
    const signer = jwk
      ? legExportSigner(leg, {
          ...(jwk as { kty: "EC"; crv: "P-256"; x: string; y: string }),
          kid: await calculateJwkThumbprint(jwk),
        })
      : undefined;
    cached = { at: clock(), signer };
    return signer;
  };
}

/** The deps' issuer, resolved now. */
const issuerOf = async (deps: Pick<Deps, "exportIssuer">): Promise<ExportSigner | undefined> =>
  typeof deps.exportIssuer === "function" ? deps.exportIssuer() : deps.exportIssuer;
