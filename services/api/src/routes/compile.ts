import { randomBytes } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  compileMandate,
  type Limits,
  MAX_PROMPT_CHARS,
  type Role,
  type SystemFields,
} from "@keelson/compiler";
import { sha256, toHex } from "@keelson/core";
import { FIELD_IDS, type Mandate, MandateSchema, RP_ID, STRING_LIMITS } from "@keelson/mandate";
import { POLICY_SET_HASH } from "@keelson/policy/hashes";
import type { Context } from "hono";
import { ulid } from "ulid";
import type { Deps } from "../app.ts";
import { SourceUnavailable } from "../compile-sources.ts";
import { admitJudgeCompile, isJudge, JUDGE_COMPILES } from "../judge.ts";
import { passkeyJwk } from "../mandate-signature.ts";
import { MERCHANTS } from "../merchants.ts";
import { requireSession } from "../middleware/auth.ts";
import { clientAddress, rateLimit } from "../middleware/rate-limit.ts";
import { userPasskeys } from "../passkeys.ts";
import type { Principal } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { Card } from "./mandates.ts";

/**
 * Mandate inputs that come from the agent operator and the TEE rather than from Keelson's own
 * records. Compiling answers 503 until every one is set.
 */
export interface CompileSources {
  /** The agent operator, its proof-of-possession key and its bond. */
  agent?: (userId: string) => Promise<Mandate["agent"]>;
  /** The consent the user gives, with the hash of the terms. */
  consent?: (userId: string) => Promise<Mandate["consent"]>;
  /** The policy engine build and its TEE measurements. */
  engine?: () => Promise<Pick<Mandate["policy"], "engine" | "version" | "measurements">>;
}

const SOURCES = ["agent", "consent", "engine"] as const;

/**
 * How long a compile may run. It stays below the 30 s handler timeout, which stays below the
 * idempotency lock, so a compile ends with its typed result before either and a retry never runs
 * while a first attempt is still paying for model calls.
 * @internal
 */
export const COMPILE_DEADLINE_MS = 25_000;

/**
 * Per-model limits whose worst case, the pair and then the check, fits the deadline.
 * @internal
 */
export const COMPILE_LIMITS: Readonly<
  Record<Role, Required<Pick<Limits, "timeout" | "maxRetries">>>
> = {
  opus: { timeout: 12_000, maxRetries: 0 },
  sonnet: { timeout: 12_000, maxRetries: 0 },
  haiku: { timeout: 8_000, maxRetries: 0 },
};

const CompileRequest = z
  .object({
    prompt: z
      .string()
      .min(1)
      .openapi({
        description: `The shopping request in natural language, at most ${MAX_PROMPT_CHARS} UTF-16 code units.`,
        example: "Running shoes, size 10, under $100, free returns, by Friday",
      }),
    credentialId: z.string().min(1).optional().openapi({
      description: "The passkey that will sign the mandate; defaults to the most recent one.",
    }),
    mode: z.enum(["immediate", "autonomous"]).default("autonomous").openapi({
      description: "Whether the user is present at checkout (`immediate`) or not (`autonomous`).",
    }),
  })
  .openapi("CompileMandate");

const CompiledMandate = z
  .object({
    mandateDraft: z.strictObject(MandateSchema.shape).openapi("MandateDraft", {
      description: "The compiled `keelson.mandate.1` payload, unsigned; its commitment is zero.",
    }),
    card: Card,
    ambiguous: z.array(z.enum(FIELD_IDS)).openapi({
      description:
        "Card fields the compilations disagreed on or the request left unstated, shown gray for the user to settle. Pass them to `prepareSigning` so the card the user signs shows them gray too.",
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

// Each compile pays for three model calls, so the limit holds even when its store is down.
const COMPILE_LIMIT = { name: "compile", limit: 10, windowSec: 60, failClosed: true } as const;

/** Compile errors the user settles by restating the request, with the slug that answers each. */
const USER_ERRORS: Readonly<Record<string, [slug: string, title: string, detail: string]>> = {
  conflict: [
    "compile-conflict",
    "Compilations conflict",
    "The request reads two incompatible ways; ask the user to settle the fields.",
  ],
  needs_input: [
    "compile-needs-input",
    "Input needed",
    "The request does not state a value a mandate needs; ask the user for the fields.",
  ],
  no_merchant: ["compile-unresolved", "Request incomplete", "No named store is onboarded."],
  no_category: ["compile-unresolved", "Request incomplete", "The item fits no category."],
  deadline_passed: ["compile-unresolved", "Request incomplete", "The deadline has passed."],
};

type Fields = Omit<SystemFields, "mid" | "iat" | "nonce" | "merchants">;
type ContextProblem = ReturnType<typeof problem<401 | 403 | 409 | 422 | 503>>;

/** The mandate fields a compile fills, and the model client it compiles with. */
async function compileContext(
  c: Context,
  deps: Pick<Deps, "db" | "passkeyRpId" | "rateLimit" | "compileSources" | "anthropic">,
  userId: string,
  body: { credentialId?: string | undefined; mode: Mandate["mode"] },
): Promise<(Fields & { client: Anthropic }) | ContextProblem> {
  const context = await signingContext(
    c,
    deps,
    userId,
    body,
    deps.compileSources?.agent,
    deps.anthropic ? [] : ["anthropic"],
  );
  if (context instanceof Response) return context;
  return { ...context, client: deps.anthropic as Anthropic };
}

/**
 * The mandate fields Keelson fills: the user and the passkey that will sign, the policy set, the
 * request's risk data, the operator from `agent`, and the consent and TEE inputs from `sources`.
 * Answers with a problem when one is missing, or 503 naming `unavailable` too.
 */
export async function signingContext(
  c: Context,
  deps: Pick<Deps, "db" | "passkeyRpId" | "rateLimit" | "compileSources">,
  userId: string,
  body: { credentialId?: string | undefined; mode: Mandate["mode"] },
  agent: ((userId: string) => Promise<Mandate["agent"]>) | undefined,
  unavailable: string[] = [],
): Promise<Fields | ContextProblem> {
  const passkeys = await userPasskeys(deps.db, userId);
  const key = body.credentialId
    ? passkeys.find((p) => p.credentialID === body.credentialId)
    : passkeys.at(-1);
  if (!key && !body.credentialId) {
    return problem(c, 409, "passkey-required", "Passkey required", "Add a passkey to sign with.");
  }
  const notOwned = () =>
    problem(
      c,
      403,
      "credential-not-owned",
      "Credential not owned",
      "The mandate must be signed with one of your passkeys.",
    );
  if (!key) return notOwned();
  let jwk: { x: string; y: string };
  try {
    jwk = passkeyJwk(key);
  } catch {
    return notOwned();
  }

  const device = c.req.header("keelson-device")?.trim();
  if (!device || device.length > STRING_LIMITS.short) {
    return problem(
      c,
      422,
      "device-required",
      "Device required",
      `Send the app's device id in Keelson-Device, at most ${STRING_LIMITS.short} characters.`,
    );
  }

  const ip = clientAddress(c, deps.rateLimit?.trustProxy ?? false);
  if (ip === undefined) {
    return problem(
      c,
      422,
      "client-ip-required",
      "Client address unknown",
      "The request's client address cannot be read, so it cannot be recorded in the mandate.",
    );
  }

  const sources = { ...deps.compileSources, agent };
  const missing: string[] = [...SOURCES.filter((s) => sources[s] === undefined), ...unavailable];
  const { consent, engine } = sources;
  if (!agent || !consent || !engine || missing.length > 0) {
    return problem(
      c,
      503,
      "compile-unavailable",
      "Compiling unavailable",
      `Compiling needs inputs that are not available yet: ${missing.join(", ")}.`,
      { missing },
    );
  }

  let filled: Pick<Mandate, "agent" | "consent"> & { policy: Awaited<ReturnType<typeof engine>> };
  try {
    filled = { agent: await agent(userId), consent: await consent(userId), policy: await engine() };
  } catch (err) {
    if (!(err instanceof SourceUnavailable)) throw err;
    return problem(
      c,
      503,
      "compile-unavailable",
      "Compiling unavailable",
      `Compiling needs inputs that are not available yet: ${err.source}.`,
      { missing: [err.source] },
    );
  }

  const user = await deps.db.query.user.findFirst({
    columns: { email: true },
    where: (row, { eq }) => eq(row.id, userId),
  });
  if (!user) return problem(c, 401, "unauthorized", "Unauthorized", "A session is required.");
  return {
    mode: body.mode,
    user: {
      sub: userId,
      cred: {
        id: key.credentialID,
        rp_id: deps.passkeyRpId ?? RP_ID,
        jwk: { kty: "EC", crv: "P-256", ...jwk },
      },
      app_login_id: user.email,
    },
    agent: filled.agent,
    consent: filled.consent,
    policy: { ...filled.policy, policy_set_hash: POLICY_SET_HASH },
    risk_data: { device_fp: device, ip },
  };
}

export function registerCompile(
  app: OpenAPIHono,
  deps: Pick<
    Deps,
    "db" | "kv" | "log" | "passkeyRpId" | "rateLimit" | "compileSources" | "anthropic"
  >,
): void {
  const route = createRoute({
    method: "post",
    path: "/v1/mandates/compile",
    tags: ["mandates"],
    summary: "Compile a mandate from a shopping request",
    description:
      "Two models compile the request independently; fields they disagree on or the request leaves unstated come back ambiguous, and a third model checks the rendered card against the request. Limited to 10 requests a minute per user.",
    middleware: [requireSession(), rateLimit(deps.kv, COMPILE_LIMIT)],
    request: {
      headers: z.object({
        "idempotency-key": z.string().min(1).max(255),
        "keelson-device": z.string().max(STRING_LIMITS.short).optional().openapi({
          description: "The app's opaque device id, recorded as `risk_data.device_fp`. Required.",
        }),
      }),
      body: { required: true, content: { "application/json": { schema: CompileRequest } } },
    },
    responses: {
      200: {
        description: "The draft mandate and its card",
        content: { "application/json": { schema: CompiledMandate } },
      },
      401: { description: "Not signed in", content: problemContent },
      403: { description: "The passkey is not the user's", content: problemContent },
      409: { description: "The user has no passkey to sign with", content: problemContent },
      422: {
        description:
          "The prompt is too long (`prompt-too-long`), the device id is missing (`device-required`), the compilations conflict (`compile-conflict`), the request leaves out a value a mandate needs (`compile-needs-input`) or cannot become a mandate (`compile-unresolved`); `fields` names what to ask the user",
        content: problemContent,
      },
      429: { description: "Too many compilations", content: problemContent },
      502: { description: "The models failed to compile the request", content: problemContent },
      503: {
        description:
          "Inputs a mandate needs are not available yet (`compile-unavailable`; `missing` names them), or the rate limit store is unreachable",
        content: problemContent,
      },
    },
  });

  app.openapi(route, async (c) => {
    const body = c.req.valid("json");
    const { prompt } = body;
    if (prompt.length > MAX_PROMPT_CHARS) {
      return problem(
        c,
        422,
        "prompt-too-long",
        "Prompt too long",
        `The prompt must be at most ${MAX_PROMPT_CHARS} characters.`,
      );
    }
    const userId = (c.get("principal") as Principal).subject;
    const context = await compileContext(c, deps, userId, body);
    if (context instanceof Response) return context;
    if ((await isJudge(deps.db, userId)) && !(await admitJudgeCompile(deps.kv, userId))) {
      return problem(
        c,
        429,
        "judge-compiles-spent",
        "Compiles spent",
        `A Judge Mode session compiles at most ${JUDGE_COMPILES} mandates.`,
      );
    }

    const { client, ...system } = context;
    const r = await compileMandate(
      prompt,
      {
        ...system,
        mid: ulid(),
        iat: Math.floor(Date.now() / 1000),
        nonce: randomBytes(16).toString("base64url"),
        merchants: MERCHANTS,
      },
      {
        client,
        signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(COMPILE_DEADLINE_MS)]),
        limits: COMPILE_LIMITS,
      },
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
    const userError = USER_ERRORS[code];
    if (userError) {
      const [slug, title, detail] = userError;
      return problem(c, 422, slug, title, detail, { code, fields });
    }
    return problem(
      c,
      502,
      "compile-failed",
      "Compile failed",
      "The models could not compile the request.",
      { code },
    );
  });
}
