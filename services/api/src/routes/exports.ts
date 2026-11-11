import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ALIBI_MEDIA_TYPE_V2,
  type AlibiBundle,
  type AlibiBundleV2,
  encodeAny,
} from "@keelson/alibi";
import {
  BindingError,
  type EcPublicJwk,
  ExportRefused,
  type ExportSigner,
  exportOne,
  type Format,
  jwks,
  purchaseFacts,
  refOf,
} from "@keelson/interop";
import { renderEvidencePackPdf } from "@keelson/interop/visa-pdf";
import type { Context } from "hono";
import { loadBridge } from "../alibi/bridge.ts";
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
    const level = stored && (await access(deps, c.get("principal"), stored));
    if (!stored || !level)
      return problem(c, 404, "alibi-not-found", "Not found", "No alibi with this id.");
    const v2 = isV2(stored) ? stored : await loadBridge(deps.db, id);
    if (!v2) return refused(c, "v1_alibi");
    if (!deps.exportIssuer) return refused(c, "signer_unavailable", 503);
    const served = level === "full" ? stored : publicCopy(stored);
    const f = purchaseFacts(served);
    const cnf = f.mandate.agent?.cnf?.jwk as { x?: string; y?: string } | undefined;
    const agent =
      deps.hostedAgent && cnf?.x === deps.hostedAgent.jwk.x && cnf?.y === deps.hostedAgent.jwk.y
        ? deps.hostedAgent
        : undefined;
    const keys = {
      issuer: deps.exportIssuer,
      ...(agent ? { agent } : {}),
      ...(deps.agentHttpKey
        ? { agentHttp: deps.agentHttpKey, signatureAgent: SIGNATURE_AGENT }
        : {}),
    };
    const base = format === "visa.pdf" ? "visa" : format;
    try {
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

  app.get("/.well-known/jwks.json", (c) => {
    const keys = [deps.exportIssuer?.jwk, deps.hostedAgent?.jwk].filter((k) => k !== undefined);
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

const BINDING_CODES = new Set(["export.facts", "export.binding", "export.typ", "export.statement"]);

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
        if (e instanceof LegError && e.status === 404)
          throw new ExportRefused("signer_unavailable");
        if (e instanceof LegError && e.code && BINDING_CODES.has(e.code)) {
          throw new BindingError(e.code as BindingError["code"]);
        }
        throw e;
      }
    },
  };
}
