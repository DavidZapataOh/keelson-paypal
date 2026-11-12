import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Deps } from "../app.ts";
import { requireAgent } from "../middleware/auth.ts";
import { principalKey } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { VERIFYING_CONTRACT } from "../tee/config.ts";
import { activeSigner } from "../tee/signers.ts";
import { type SignedWebFact, verifyWebFact, WebFactError } from "../web-fact.ts";

/** MPC-TLS keeps a CPU of leg A busy for seconds; one client proves at most this many a day. */
const DAILY_PER_CLIENT = 50;
const DAY_SEC = 86_400;
/** Two attempts of the prover (MPC-TLS, then Proxy-TLS), 30 s each at most. */
const PROVER_TIMEOUT_MS = 65_000;

const Hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);

/** An `https` URL on port 443 with a DNS host and no credentials or fragment. */
function isPublicUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return (
    // Only a normalized URL: the notary hashes the host and target exactly as they are sent.
    url.href === value &&
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    isIP(host) === 0 &&
    host.includes(".")
  );
}

const Body = z
  .object({
    url: z
      .string()
      .max(1024)
      .refine(
        isPublicUrl,
        "The URL must be https on port 443, name a DNS host and carry no credentials.",
      )
      .openapi({
        description:
          "A public JSON product endpoint, such as a Shopify store's `/products/<handle>.js`.",
      }),
    anchor: z.string().min(1).max(256).optional().openapi({
      description:
        'Commit to the smallest JSON object in the body that contains this text (a variant\'s `"id":123`) instead of the whole body.',
    }),
  })
  .openapi("WebFactRequest");

const Created = z
  .object({
    webFact: z.object({
      web_fact: z.object({
        hostHash: Hex32,
        urlPathHash: Hex32,
        tCapture: z.number().int(),
        rangeCommitment: Hex32,
        attId: Hex32,
      }),
      chain_id: z.number().int(),
      digest: Hex32,
      signature: z.string(),
      signer: z.string(),
    }),
    mode: z.enum(["mpc", "proxy"]),
    ms: z.number().int().openapi({ description: "How long the TLSNotary session took." }),
    range: z.tuple([z.number().int(), z.number().int()]).openapi({
      description: "The committed range of the response, `[start, end)`.",
    }),
    committed: z.string().openapi({ description: "The committed bytes, hex." }),
    blinder: z.string().openapi({
      description: "The 16-byte blinder, hex: `rangeCommitment` is `SHA-256(committed ‖ blinder)`.",
    }),
  })
  .openapi("WebFact");

const problemContent = { "application/problem+json": { schema: ProblemSchema } };

const create = createRoute({
  method: "post",
  path: "/v1/observations/web-fact",
  operationId: "notarizeWebFact",
  tags: ["evidence"],
  summary: "Notarize a product endpoint with TLSNotary",
  description:
    "Fetches the endpoint once over TLS with leg A as the TLSNotary notary (MPC-TLS, or Proxy-TLS when MPC-TLS fails), commits to the body or to the object around `anchor`, and returns the EIP-712 `WebFact` leg A signed with its attested key. Runs apart from any countersign and never delays one. An app acting for a user needs `evidence:write`.",
  middleware: [requireAgent("evidence:write")],
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(255) }),
    body: { required: true, content: { "application/json": { schema: Body } } },
  },
  responses: {
    201: {
      description: "The signed WebFact",
      content: { "application/json": { schema: Created } },
    },
    422: {
      description: "The URL is refused, or its response is not a 200 the notary accepts",
      content: problemContent,
    },
    429: { description: "Too many WebFacts today for this client", content: problemContent },
    502: {
      description: "The session failed, or its WebFact did not verify",
      content: problemContent,
    },
    503: {
      description:
        "No prover is configured, leg A has no admitted signer, or the rate limit store is unreachable",
      content: problemContent,
    },
  },
});

export function registerWebFacts(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "kv" | "log" | "prover">,
): void {
  const { db, kv, log } = deps;

  app.openapi(create, async (c) => {
    const prover = deps.prover;
    if (!prover) {
      return problem(
        c,
        503,
        "prover-unconfigured",
        "Prover unconfigured",
        "No prover is configured.",
      );
    }
    const body = c.req.valid("json");
    const principal = c.var.principal as NonNullable<typeof c.var.principal>;
    const now = Math.floor(Date.now() / 1000);
    // An app acting for a user counts against that user, however many apps they connect.
    const owner = principal.user
      ? principalKey({ kind: "user", subject: principal.user })
      : principalKey(principal);
    const day = `rl:web-fact-day:${owner}:${Math.floor(now / DAY_SEC)}`;
    let count: number;
    try {
      const replies = await kv.multi().incr(day).expire(day, DAY_SEC, "NX").exec();
      count = Number(replies[0]);
    } catch {
      return problem(
        c,
        503,
        "dependency-unavailable",
        "Dependency unavailable",
        "The rate limit store is unreachable.",
      );
    }
    if (count > DAILY_PER_CLIENT) {
      c.header("Retry-After", String(DAY_SEC - (now % DAY_SEC)));
      return problem(
        c,
        429,
        "rate-limited",
        "Too many requests",
        "Too many WebFacts today for this client.",
      );
    }
    const signer = await activeSigner(db, 1);
    if (!signer) {
      return problem(c, 503, "tee-unavailable", "TEE unavailable", "Leg A has no admitted signer.");
    }

    let res: Response;
    try {
      res = await fetch(`${prover.replace(/\/$/, "")}/v1/prove`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: body.url, ...(body.anchor ? { anchor: body.anchor } : {}) }),
        signal: AbortSignal.timeout(PROVER_TIMEOUT_MS),
      });
    } catch (err) {
      log.warn({ err }, "prover unreachable");
      return problem(c, 502, "prover-failed", "Prover failed", "The prover did not answer.");
    }
    const answer = (await res.json().catch(() => null)) as
      | z.infer<typeof Created>
      | { error?: string }
      | null;
    if (!res.ok || !answer || !("webFact" in answer)) {
      const error = answer && "error" in answer ? answer.error : undefined;
      log.warn({ status: res.status, error }, "web fact not proven");
      return res.status === 422
        ? problem(
            c,
            422,
            "web-fact-refused",
            "WebFact refused",
            "The endpoint's response cannot be notarized.",
          )
        : problem(c, 502, "prover-failed", "Prover failed", "The TLSNotary session failed.");
    }
    try {
      await verifyWebFact(
        answer.webFact as SignedWebFact,
        new URL(body.url),
        { address: signer.address, binding: signer.binding },
        VERIFYING_CONTRACT,
      );
    } catch (err) {
      const code = err instanceof WebFactError ? err.code : "signature";
      log.error({ code }, "web fact did not verify");
      return problem(
        c,
        502,
        "web-fact-invalid",
        "WebFact invalid",
        `The WebFact failed its ${code} check.`,
      );
    }
    const opened = createHash("sha256")
      .update(Buffer.from(answer.committed, "hex"))
      .update(Buffer.from(answer.blinder, "hex"))
      .digest("hex");
    if (`0x${opened}` !== answer.webFact.web_fact.rangeCommitment.toLowerCase()) {
      log.error("web fact range does not open its commitment");
      return problem(
        c,
        502,
        "web-fact-invalid",
        "WebFact invalid",
        "The committed bytes do not open the WebFact's range commitment.",
      );
    }
    c.header("Server-Timing", `tlsn;dur=${answer.ms}`);
    return c.json(answer, 201);
  });
}
