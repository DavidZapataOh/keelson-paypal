import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { type AlibiBundle, verifyUrl } from "@keelson/alibi";
import { and, eq, gte, isNotNull, mandates, purchases, sql } from "@keelson/db";
import {
  acpDelegation,
  alibiHeader,
  ap2Receipts,
  checkoutJwt,
  checkoutMandate,
  closeAp2,
  closeVi,
  type EcPublicJwk,
  evidencePack,
  instrumentOf,
  issueAp2Open,
  issueViL2,
  type PurchaseFacts,
  purchaseFacts,
  type Signer,
  signAgentRequest,
  TAP_TAGS,
  UCP_VERSION,
  ucpCheckout,
} from "@keelson/interop";
import { renderEvidencePackPdf } from "@keelson/interop/visa-pdf";
import type { Context } from "hono";
import type { Deps } from "../app.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { readableAlibi } from "./alibis.ts";

/** Who Keelson is in the exports it signs, and where its keys are published. */
const ISSUER = "https://keelson.finance";
const NETWORK = "https://www.paypal.com";

export const EXPORT_FORMATS = ["ap2", "vi", "ucp", "acp", "tap", "visa", "visa.pdf"] as const;
type Format = (typeof EXPORT_FORMATS)[number];

const exportRoute = createRoute({
  method: "get",
  path: "/v1/alibis/{id}/exports/{format}",
  tags: ["alibis"],
  summary: "An alibi in an industry format",
  description:
    "The Alibi's mandate and purchase in AP2 v0.2 (`ap2`), Mastercard Verifiable Intent v0.1 (`vi`), UCP 2026-08-25 with AP2 mandates (`ucp`), ACP 2026-04-17 Delegate Payment (`acp`), Visa TAP / Web Bot Auth (`tap`) or the Visa §4.1.23 / CE3.0 Agentic Evidence Pack (`visa`, `visa.pdf`). Same readers as the bundle: anyone else gets the export of its public copy, whose evidence pack withholds the CE3.0 personal elements. Keelson signs as the trusted surface (keys at `/.well-known/jwks.json`); the closed mandates and TAP signature need the agent's own key, so they are present only for Keelson's hosted operator, and the agent closes the open mandates itself otherwise. Signed claims are dated at the countersign (`verify_at`).",
  request: {
    params: z.object({
      id: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
      format: z.enum(EXPORT_FORMATS),
    }),
    query: z.object({
      aud: z
        .string()
        .max(2048)
        .optional()
        .openapi({ description: "The audience of the closed mandates: the merchant." }),
      nonce: z
        .string()
        .max(256)
        .optional()
        .openapi({ description: "The verifier's nonce; the Alibi id by default." }),
    }),
  },
  responses: {
    200: {
      description: "The export; `visa.pdf` is a PDF/A-3b that embeds the JSON pack",
      content: {
        "application/json": { schema: z.record(z.string(), z.unknown()) },
        "application/pdf": { schema: z.string().openapi({ format: "binary" }) },
      },
    },
    404: {
      description: "No alibi with this id that the caller may read",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    503: {
      description: "Exports are not configured",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const JwksSchema = z.object({ keys: z.array(z.record(z.string(), z.unknown())) }).openapi("Jwks");

const jwksRoute = createRoute({
  method: "get",
  path: "/.well-known/jwks.json",
  tags: ["alibis"],
  summary: "Keelson's export signing keys",
  description:
    "The ES256 keys that sign Keelson's AP2, Verifiable Intent and UCP exports and receipts (RFC 7517).",
  responses: {
    200: { description: "The JWK set", content: { "application/json": { schema: JwksSchema } } },
  },
});

/** The hosted agent as the mandate names its key, when the mandate delegates to it. */
function agentFor(f: PurchaseFacts, hosted: Signer | undefined): Signer | undefined {
  const cnf = f.mandate.agent?.cnf?.jwk as EcPublicJwk | undefined;
  if (!hosted || !cnf || cnf.x !== hosted.jwk.x || cnf.y !== hosted.jwk.y) return undefined;
  return { ...hosted, kid: cnf.kid ?? hosted.kid };
}

/**
 * What was left of the mandate's budget when the purchase was countersigned: what is left now
 * plus every capture of the mandate since, its own included.
 */
async function budgetLeftAt(db: Deps["db"], alibiId: string): Promise<bigint | undefined> {
  const [p] = await db
    .select({ mandateId: purchases.mandateId, createdAt: purchases.createdAt })
    .from(purchases)
    .where(eq(purchases.id, alibiId));
  if (!p) return undefined;
  const [row] = await db
    .select({
      remaining: mandates.remainingMinor,
      since: sql<string>`(select coalesce(sum(${purchases.amountMinor}), 0) from ${purchases} where ${and(
        eq(purchases.mandateId, p.mandateId),
        gte(purchases.createdAt, p.createdAt),
        isNotNull(purchases.paypalCaptureId),
      )})`,
    })
    .from(mandates)
    .where(eq(mandates.id, p.mandateId));
  return row ? row.remaining + BigInt(row.since) : undefined;
}

/** The PayPal order's shipping address, on one line, when PayPal has one. */
async function shippingOf(
  deps: { paypal?: Deps["paypal"] | undefined },
  orderId: string | undefined,
): Promise<string | undefined> {
  if (!deps.paypal || !orderId) return undefined;
  try {
    const order = await deps.paypal.paypal.orders.getOrder({ id: orderId });
    const a = order.result.purchaseUnits?.[0]?.shipping?.address;
    if (!a) return undefined;
    return [a.addressLine1, a.addressLine2, a.adminArea2, a.adminArea1, a.postalCode, a.countryCode]
      .filter(Boolean)
      .join(", ");
  } catch {
    return undefined;
  }
}

async function build(
  format: Exclude<Format, "visa.pdf">,
  b: AlibiBundle,
  full: boolean,
  deps: {
    db: Deps["db"];
    paypal?: Deps["paypal"] | undefined;
    keelson: Signer;
    hostedAgent?: Signer | undefined;
  },
  q: { aud?: string | undefined; nonce?: string | undefined },
): Promise<Record<string, unknown>> {
  const f = purchaseFacts(b);
  const agent = agentFor(f, deps.hostedAgent);
  const iat = f.issuedAt;
  const nonce = q.nonce ?? b.alibi_id;
  const merchantAud = q.aud ?? f.merchant.website ?? f.merchant.id;
  const alibi = `https://api.keelson.finance/v1/alibis/${b.alibi_id}`;
  const common = {
    alibi_id: b.alibi_id,
    verify_url: verifyUrl(b),
    verify_at: iat,
    jwks_uri: `${ISSUER}/.well-known/jwks.json`,
  };
  const instrument = instrumentOf(f.mandate, f.card);
  switch (format) {
    case "ap2": {
      const open = await issueAp2Open(f.mandate, deps.keelson, {
        mandateHash: f.mandateHash,
        instrument,
      });
      const cjwt = await checkoutJwt(f, deps.keelson);
      if (!agent)
        return {
          format: "ap2",
          version: "0.2.0",
          ...common,
          open,
          checkout_jwt: cjwt,
          closed: null,
          notes: open.notes,
        };
      const closed = await closeAp2(open, f, cjwt, agent, {
        nonce,
        iat,
        merchantAud,
        paymentAud: NETWORK,
      });
      const receipts = await ap2Receipts(closed, f, deps.keelson, { iss: ISSUER, iat });
      return {
        format: "ap2",
        version: "0.2.0",
        ...common,
        open,
        checkout_jwt: cjwt,
        closed,
        receipts,
        notes: open.notes,
      };
    }
    case "vi": {
      const chain = await issueViL2(f.mandate, deps.keelson, {
        mandateHash: f.mandateHash,
        iss: ISSUER,
        instrument,
        payee: f.payee,
      });
      const cjwt = await checkoutJwt(f, deps.keelson);
      const l3 = agent
        ? await closeVi(chain, f, cjwt, agent, { nonce, iat, networkAud: NETWORK, merchantAud })
        : null;
      const { refs: _, ...l2 } = chain;
      return { format: "vi", version: "0.1", ...common, ...l2, l3 };
    }
    case "ucp": {
      const checkout = ucpCheckout(f);
      const mandate = await checkoutMandate(checkout, deps.keelson, {
        iat,
        ...(agent ? { agent, aud: merchantAud, nonce } : {}),
      });
      return {
        format: "ucp",
        version: UCP_VERSION,
        ...common,
        checkout,
        complete: { ap2: { checkout_mandate: mandate } },
      };
    }
    case "acp": {
      const range = f.mandate.payment?.constraints?.find((c) => c?.type === "payment.amount_range");
      const cap = range && "max" in range ? range.max : undefined;
      const left = await budgetLeftAt(deps.db, b.alibi_id);
      const delegation = acpDelegation({
        currency: f.currency,
        maxAmountMinor: cap ?? f.totalMinor,
        remainingMinor: Number(left ?? BigInt(cap ?? f.totalMinor)),
        exp: f.mandate.exp ?? iat,
        now: iat,
        checkoutSessionId: f.paypal?.order_id ?? b.alibi_id,
        merchantId: f.payee ?? f.merchant.id,
        alibiId: b.alibi_id,
      });
      return { format: "acp", version: "2026-04-17", ...common, ...delegation };
    }
    case "tap": {
      const header = alibiHeader(b.alibi_id, verifyUrl(b));
      const request = new Request(
        new URL("/checkout", f.merchant.website ?? `https://${f.merchant.id}`),
        {
          method: "POST",
          headers: { "Keelson-Alibi": header },
        },
      );
      const signed = agent
        ? await signAgentRequest(request, agent, {
            tag: TAP_TAGS.pay,
            created: iat,
            nonce,
            withAlibi: true,
          })
        : null;
      return {
        format: "tap",
        ...common,
        request: { method: "POST", url: request.url },
        headers: {
          "Keelson-Alibi": header,
          ...(signed
            ? { "Signature-Input": signed.signatureInput, Signature: signed.signature }
            : {}),
        },
        keyid: agent?.kid ?? (f.mandate.agent?.cnf?.jwk as EcPublicJwk | undefined)?.kid ?? null,
      };
    }
    case "visa":
      return {
        ...evidencePack(b, f, {
          now: new Date(),
          alibiUrl: alibi,
          shipping: full ? await shippingOf(deps, f.paypal?.order_id) : undefined,
        }),
      };
  }
}

export function registerExports(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "demoAgentId" | "paypal" | "exportSigner" | "hostedAgent">,
): void {
  app.openapi(jwksRoute, (c) => {
    const k = deps.exportSigner;
    c.header("Cache-Control", "public, max-age=3600");
    return c.json({ keys: k ? [{ ...k.jwk, kid: k.kid, alg: "ES256", use: "sig" }] : [] }, 200);
  });

  app.openapi(exportRoute, (async (c: Context) => {
    const { id, format } = c.req.param() as { id: string; format: Format };
    if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
      return problem(c, 404, "export-not-found", "Not found", "No such export format.");
    }
    const keelson = deps.exportSigner;
    if (!keelson)
      return problem(
        c,
        503,
        "exports-unavailable",
        "Exports unavailable",
        "Exports are not configured.",
      );
    const read = await readableAlibi(deps, c, id);
    if (!read) return problem(c, 404, "alibi-not-found", "Not found", "No alibi with this id.");
    const q = { aud: c.req.query("aud"), nonce: c.req.query("nonce") };
    c.header("Cache-Control", "private, no-store");
    c.header("Vary", "Cookie, Authorization", { append: true });
    const ctx = { db: deps.db, paypal: deps.paypal, keelson, hostedAgent: deps.hostedAgent };
    if (format === "visa.pdf") {
      const pack = await build("visa", read.bundle, read.full, ctx, q);
      const pdf = await renderEvidencePackPdf(pack as never);
      return c.body(pdf as Uint8Array<ArrayBuffer>, 200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${id}.visa-evidence.pdf"`,
      });
    }
    const body = await build(format, read.bundle, read.full, ctx, q);
    c.header("Content-Disposition", `attachment; filename="${id}.${format}.json"`);
    return c.json(body, 200);
  }) as never);
}
