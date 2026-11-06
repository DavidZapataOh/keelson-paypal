import { randomBytes } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { compileMandate, MAX_PROMPT_CHARS, type SystemFields } from "@keelson/compiler";
import { sha256, toHex } from "@keelson/core";
import { ulid } from "ulid";
import type { Deps } from "../app.ts";
import { MERCHANTS } from "../merchants.ts";
import { requireSession } from "../middleware/auth.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import type { Principal } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { Card } from "./mandates.ts";

/** The mandate fields Keelson fills for a user: everything but the compiled limits. */
export type CompileContext = Omit<SystemFields, "mid" | "iat" | "nonce" | "merchants">;

const CompileRequest = z
  .object({
    prompt: z
      .string()
      .min(1)
      .openapi({
        description: `The shopping request in natural language, at most ${MAX_PROMPT_CHARS} UTF-16 code units.`,
        example: "Running shoes, size 10, under $100, free returns, by Friday",
      }),
  })
  .openapi("CompileMandate");

const CompiledMandate = z
  .object({
    mandateDraft: z.record(z.string(), z.unknown()).openapi({
      description: "The compiled `keelson.mandate.1` payload, unsigned; its commitment is zero.",
    }),
    card: Card,
    ambiguous: z.array(z.string()).openapi({
      description: "Card fields the compilations disagreed on, shown gray for the user to settle.",
    }),
    check: z
      .object({
        status: z.enum(["ok", "refused", "failed", "aborted", "skipped"]),
        discrepancies: z.array(z.object({ field: z.string(), issue: z.string() })).nullable(),
      })
      .openapi({
        description:
          "The round trip of the card against the request. Only `ok` means it was checked.",
      }),
  })
  .openapi("CompiledMandate");

const problemContent = { "application/problem+json": { schema: ProblemSchema } };

const COMPILE_LIMIT = { name: "compile", limit: 10, windowSec: 60 } as const;

/** Compile errors the user settles by restating the request. */
const UNRESOLVED = new Set(["no_merchant", "no_category", "deadline_passed"]);

export function registerCompile(
  app: OpenAPIHono,
  deps: Pick<Deps, "kv" | "log" | "compileContext">,
): void {
  const route = createRoute({
    method: "post",
    path: "/v1/mandates/compile",
    tags: ["mandates"],
    summary: "Compile a mandate from a shopping request",
    description:
      "Two models compile the request independently; fields they disagree on come back ambiguous, and a third model checks the rendered card against the request. Limited to 10 requests a minute per user.",
    middleware: [requireSession(), rateLimit(deps.kv, COMPILE_LIMIT)],
    request: {
      headers: z.object({ "idempotency-key": z.string().min(1).max(255) }),
      body: { required: true, content: { "application/json": { schema: CompileRequest } } },
    },
    responses: {
      200: {
        description: "The draft mandate and its card",
        content: { "application/json": { schema: CompiledMandate } },
      },
      401: { description: "Not signed in", content: problemContent },
      422: {
        description:
          "The prompt is too long (`prompt-too-long`), the compilations conflict (`compile-conflict`) or the request lacks what a mandate needs (`compile-unresolved`); `fields` names what to ask the user",
        content: problemContent,
      },
      429: { description: "Too many compilations", content: problemContent },
      502: { description: "The models failed to compile the request", content: problemContent },
      503: { description: "Compiling is not configured", content: problemContent },
    },
  });

  app.openapi(route, async (c) => {
    const { prompt } = c.req.valid("json");
    if (prompt.length > MAX_PROMPT_CHARS) {
      return problem(
        c,
        422,
        "prompt-too-long",
        "Prompt too long",
        `The prompt must be at most ${MAX_PROMPT_CHARS} characters.`,
      );
    }
    if (!deps.compileContext) {
      return problem(c, 503, "compile-unavailable", "Compiling unavailable");
    }
    const userId = (c.get("principal") as Principal).subject;
    const context = await deps.compileContext(userId);
    const r = await compileMandate(
      prompt,
      {
        ...context,
        mid: ulid(),
        iat: Math.floor(Date.now() / 1000),
        nonce: randomBytes(16).toString("base64url"),
        merchants: MERCHANTS,
      },
      { signal: c.req.raw.signal },
    );
    deps.log.info(
      {
        requestId: c.get("requestId"),
        promptHash: toHex(sha256(new TextEncoder().encode(prompt))),
        outcome: r.ok ? "ok" : r.error.code,
        sources: r.sources,
        check: r.check.status,
        usage: r.usage,
      },
      "mandate compiled",
    );

    if (r.ok) {
      return c.json(
        { mandateDraft: r.mandate, card: r.card, ambiguous: r.ambiguous, check: r.check },
        200,
      );
    }
    const { code, fields } = r.error;
    if (code === "conflict") {
      return problem(
        c,
        422,
        "compile-conflict",
        "Compilations conflict",
        "The request reads two incompatible ways; ask the user to settle the fields.",
        { fields },
      );
    }
    if (UNRESOLVED.has(code)) {
      return problem(
        c,
        422,
        "compile-unresolved",
        "Request incomplete",
        "The request lacks what a mandate needs; ask the user about the fields.",
        { code, fields },
      );
    }
    return problem(
      c,
      502,
      "compile-failed",
      "Compile failed",
      "The models could not compile the request.",
      {
        code,
      },
    );
  });
}
