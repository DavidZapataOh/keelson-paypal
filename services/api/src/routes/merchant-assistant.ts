import type Anthropic from "@anthropic-ai/sdk";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { RedisClientType } from "redis";
import type { Deps } from "../app.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { requireMerchant } from "./merchant-console.ts";

/** The models the console's agents may ask for; the first is the default. */
const MODELS = ["claude-opus-5-5", "claude-haiku-5-5"] as const;
type Model = (typeof MODELS)[number];
const FALLBACK: Model = "claude-haiku-5-5";

/** USD micros per token: input, output, cache read, cache write (5 min). */
const PRICE: Record<Model, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};

/**
 * What a merchant's console may spend on `claude-opus-5-5` per UTC day before it falls back.
 * @internal
 */
export const DAILY_BUDGET_MICROS = 2_000_000;
/**
 * The fallback model's own ceiling; past it the proxy answers 429 until the next UTC day.
 * @internal
 */
export const FALLBACK_BUDGET_MICROS = 500_000;

const Text = z.object({ type: z.literal("text"), text: z.string() }).strict();

/** The content blocks the console's agents exchange: no media, no URLs, no cache controls. */
const Block = z.discriminatedUnion("type", [
  Text,
  z
    .object({
      type: z.literal("tool_use"),
      id: z.string().max(128),
      name: z.string().max(128),
      input: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_result"),
      tool_use_id: z.string().max(128),
      content: z.union([z.string(), z.array(Text)]),
      is_error: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("thinking"), thinking: z.string(), signature: z.string() }).strict(),
  z.object({ type: z.literal("redacted_thinking"), data: z.string() }).strict(),
]);

/** A tool the page runs: Studio's and the console's own, never a server tool. */
const Tool = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    description: z.string().max(8_000),
    input_schema: z.record(z.string(), z.unknown()),
  })
  .strict();

const Body = z
  .object({
    model: z.enum(MODELS).optional(),
    system: z.string().max(200_000),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.union([z.string(), z.array(Block).min(1)]),
          })
          .strict(),
      )
      .min(1)
      .max(400),
    tools: z.array(Tool).max(64).optional(),
    tool_choice: z.enum(["auto", "none"]).optional(),
  })
  .openapi("AssistantTurn", {
    description:
      "One turn of the console's agents: Messages API `system`, `messages` and client `tools`. The proxy sets the model limits, thinking and effort.",
  });

const route = createRoute({
  method: "post",
  path: "/v1/merchants/{merchantId}/assistant",
  tags: ["merchants"],
  summary: "One streamed model turn for the merchant console's agents",
  description:
    "Streams the Messages API events as newline-delimited JSON (the Anthropic SDK's `MessageStream.toReadableStream`). Each merchant has a daily budget; once it is spent the turn runs on `claude-haiku-5-5`, named in `Keelson-Model`.",
  request: {
    params: z.object({ merchantId: z.string().min(1).max(64) }),
    body: { required: true, content: { "application/json": { schema: Body } } },
  },
  responses: {
    200: {
      description: "The turn's events",
      headers: z.object({ "keelson-model": z.enum(MODELS) }),
      content: { "application/x-ndjson": { schema: z.string() } },
    },
    401: {
      description: "No session",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    403: {
      description: "The session is not this merchant's",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    429: {
      description: "Too many turns, or today's budget is spent",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    502: {
      description: "The model provider refused the turn",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    503: {
      description: "No model provider configured",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

/**
 * The USD micros a turn cost, from its final usage.
 * @internal
 */
export function costMicros(
  model: Model,
  usage: Pick<
    Anthropic.Messages.Usage,
    "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens"
  >,
): number {
  const [input, output, read, write] = PRICE[model];
  return Math.ceil(
    usage.input_tokens * input +
      usage.output_tokens * output +
      (usage.cache_read_input_tokens ?? 0) * read +
      (usage.cache_creation_input_tokens ?? 0) * write,
  );
}

const MAX_TOKENS = 16_000;
const LIMIT: Record<Model, number> = {
  "claude-opus-5-5": DAILY_BUDGET_MICROS,
  "claude-haiku-5-5": FALLBACK_BUDGET_MICROS,
};

const day = () => new Date().toISOString().slice(0, 10);
const spentKey = (merchantId: string, model: Model) => `assistant:${merchantId}:${model}:${day()}`;

/**
 * The most a turn can cost: every three bytes of its body an input token, and a full reply.
 * @internal
 */
export function worstCase(model: Model, bodyBytes: number): number {
  const [input, output] = PRICE[model];
  return Math.ceil(Math.ceil(bodyBytes / 3) * input + MAX_TOKENS * output);
}

async function add(kv: RedisClientType, key: string, micros: number): Promise<number> {
  const [total] = await kv
    .multi()
    .incrBy(key, micros)
    .expire(key, 2 * 86_400)
    .exec();
  return Number(total);
}

/**
 * Reserves a turn's worst case against today's budget, before it runs: the model asked for while
 * its budget lasts, else the fallback while its own lasts. Concurrent turns each hold their
 * reservation, so together they cannot pass the budget.
 * @internal
 */
export async function reserve(
  kv: RedisClientType,
  merchantId: string,
  asked: Model,
  bodyBytes: number,
): Promise<{ model: Model; reserved: number } | undefined> {
  for (const model of asked === FALLBACK ? [FALLBACK] : [asked, FALLBACK]) {
    const reserved = worstCase(model, bodyBytes);
    const key = spentKey(merchantId, model);
    if ((await add(kv, key, reserved)) <= LIMIT[model]) return { model, reserved };
    await kv.decrBy(key, reserved);
  }
  return undefined;
}

/**
 * Replaces a turn's reservation with what it cost. A turn that never finished keeps its
 * reservation.
 * @internal
 */
export async function settle(
  kv: RedisClientType,
  merchantId: string,
  turn: { model: Model; reserved: number },
  cost: number,
): Promise<void> {
  await add(kv, spentKey(merchantId, turn.model), cost - turn.reserved);
}

export function registerMerchantAssistant(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "kv" | "log" | "anthropic" | "merchantSigners">,
): void {
  const path = "/v1/merchants/:merchantId/assistant";
  app.on("POST", path, requireMerchant(deps));
  app.on("POST", path, rateLimit(deps.kv, { name: "assistant", limit: 20, windowSec: 60 }));
  app.openapi(route, (async (c: Context) => {
    const anthropic = deps.anthropic;
    if (!anthropic) {
      return problem(c, 503, "dependency-unavailable", "Model unavailable");
    }
    const merchantId = c.var.merchantId as string;
    const raw = await c.req.text();
    const body = Body.parse(JSON.parse(raw));
    const turn = await reserve(
      deps.kv,
      merchantId,
      body.model ?? MODELS[0],
      Buffer.byteLength(raw),
    );
    if (!turn) {
      return problem(
        c,
        429,
        "budget-spent",
        "Budget spent",
        "Today's assistant budget is spent; it resets at 00:00 UTC.",
      );
    }
    const { model } = turn;
    const stream = anthropic.beta.messages.stream(
      {
        model,
        max_tokens: MAX_TOKENS,
        system: body.system,
        messages: body.messages as Anthropic.Beta.BetaMessageParam[],
        ...(body.tools ? { tools: body.tools as Anthropic.Beta.BetaTool[] } : {}),
        ...(body.tool_choice ? { tool_choice: { type: body.tool_choice } } : {}),
        thinking: { type: "adaptive" },
        output_config: { effort: model === FALLBACK ? "low" : "medium" },
        ...(model === FALLBACK
          ? {}
          : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
      },
      { signal: c.req.raw.signal },
    );
    try {
      // The provider accepted the turn before the stream is handed on: its refusals are problems.
      await stream.withResponse();
    } catch (err) {
      await settle(deps.kv, merchantId, turn, 0);
      deps.log.warn({ err, merchantId }, "the model refused an assistant turn");
      return problem(c, 502, "model-error", "Model error", "The model did not take this turn.");
    }
    stream
      .finalMessage()
      .then((message) => {
        const priced = (MODELS as readonly string[]).includes(message.model)
          ? (message.model as Model)
          : model;
        return settle(deps.kv, merchantId, turn, costMicros(priced, message.usage));
      })
      .catch((err) => deps.log.warn({ err, merchantId }, "assistant turn ended without a message"));
    return new Response(stream.toReadableStream(), {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson",
        "cache-control": "no-store",
        "keelson-model": model,
      },
    });
  }) as never);
}
