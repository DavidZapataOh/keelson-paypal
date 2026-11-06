import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  buildSdPayload,
  type Card,
  type FieldId,
  type Mandate,
  renderCard,
} from "@keelson/mandate";
import { mergeDrafts, type SystemFields, toMandate } from "./diff.ts";
import { CompileError, type Draft, DraftSchema } from "./draft.ts";
import { checkMessage, draftMessage, HAIKU_SYSTEM, OPUS_SYSTEM, SONNET_SYSTEM } from "./prompts.ts";
import { CheckSchema, cardText, type Discrepancy } from "./verify.ts";

export const MODELS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
} as const;

export type Role = keyof typeof MODELS;

export type FailReason = "timeout" | "aborted" | "api_error" | "max_tokens" | "invalid_output";

/** How one model call ended. A refused or failed compiler model counts as missing. */
export type Source =
  | { status: "ok" }
  | { status: "refused"; category: string | null }
  | { status: "failed"; reason: FailReason }
  | { status: "skipped" };

export interface Usage {
  model: string;
  input: number;
  output: number;
  ms: number;
}

export type CompileResult = {
  sources: Record<Role, Source>;
  usage: Usage[];
} & (
  | {
      ok: true;
      mandate: Mandate;
      card: Card;
      ambiguous: FieldId[];
      discrepancies: Discrepancy[];
      /** Only one compiler model answered, so every field is ambiguous. */
      singleSource: boolean;
    }
  | {
      /** The request cannot become a mandate as stated; `error.fields` says what to ask. */
      ok: false;
      error: CompileError;
    }
);

/** Per-model request limits. */
export interface Limits {
  /** Request timeout in milliseconds. */
  timeout?: number;
  maxTokens?: number;
}

export interface CompileOptions {
  client?: Anthropic;
  signal?: AbortSignal;
  limits?: Partial<Record<Role, Limits>>;
}

const MAX_TOKENS = 16000;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

interface Reply {
  model: string;
  stop_reason: string | null;
  stop_details?: { category: string | null } | null;
  content: readonly { type: string; text?: string }[];
  usage: { input_tokens: number; output_tokens: number };
}

/** The final text of a reply: the text after the last fallback switch point. */
function finalText(content: Reply["content"]): string | undefined {
  const tail = content.slice(content.findLastIndex((b) => b.type === "fallback") + 1);
  const texts = tail.filter((b) => b.type === "text").map((b) => b.text ?? "");
  return texts.length ? texts.join("") : undefined;
}

/**
 * Runs one model call and classifies how it ended, recording usage. `stop_reason` is checked
 * before the structured output is parsed, since a refused or truncated reply need not match the
 * schema.
 */
async function run<T>(
  role: Role,
  format: { parse(content: string): T },
  send: (options: Anthropic.RequestOptions) => Promise<Reply>,
  opts: CompileOptions,
  usage: Usage[],
): Promise<{ source: Source; value: T | null }> {
  const failed = (reason: FailReason) => ({
    source: { status: "failed", reason } as const,
    value: null,
  });
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  let reply: Reply;
  try {
    const timeout = opts.limits?.[role]?.timeout;
    reply = await send({ ...(timeout !== undefined && { timeout }), signal: opts.signal });
  } catch (e) {
    usage.push({ model: MODELS[role], input: 0, output: 0, ms: elapsed() });
    if (e instanceof Anthropic.APIConnectionTimeoutError) return failed("timeout");
    if (e instanceof Anthropic.APIUserAbortError) return failed("aborted");
    if (e instanceof Anthropic.APIError) return failed("api_error");
    throw e;
  }
  usage.push({
    model: reply.model,
    input: reply.usage.input_tokens,
    output: reply.usage.output_tokens,
    ms: elapsed(),
  });
  if (reply.stop_reason === "refusal") {
    return {
      source: { status: "refused", category: reply.stop_details?.category ?? null },
      value: null,
    };
  }
  if (reply.stop_reason === "max_tokens") return failed("max_tokens");
  const text = finalText(reply.content);
  if (text === undefined) return failed("invalid_output");
  try {
    return { source: { status: "ok" }, value: format.parse(text) };
  } catch (e) {
    if (e instanceof Anthropic.AnthropicError) return failed("invalid_output");
    throw e;
  }
}

function draft(
  client: Anthropic,
  role: "opus" | "sonnet",
  system: string,
  content: string,
  opts: CompileOptions,
  usage: Usage[],
) {
  const format = betaZodOutputFormat(DraftSchema);
  return run<Draft>(
    role,
    format,
    (options) =>
      client.beta.messages.create(
        {
          model: MODELS[role],
          max_tokens: opts.limits?.[role]?.maxTokens ?? MAX_TOKENS,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          system,
          messages: [{ role: "user", content }],
          output_config: { effort: "medium", format },
        },
        options,
      ),
    opts,
    usage,
  );
}

function check(client: Anthropic, content: string, opts: CompileOptions, usage: Usage[]) {
  const format = zodOutputFormat(CheckSchema);
  return run(
    "haiku",
    format,
    (options) =>
      client.messages.create(
        {
          model: MODELS.haiku,
          max_tokens: opts.limits?.haiku?.maxTokens ?? MAX_TOKENS,
          system: HAIKU_SYSTEM,
          messages: [{ role: "user", content }],
          output_config: { effort: "low", format },
        },
        options,
      ),
    opts,
    usage,
  );
}

const settled = <T>(r: PromiseSettledResult<T>): T => {
  if (r.status === "rejected") throw r.reason;
  return r.value;
};

/**
 * Compiles a natural-language request into a mandate. Two models draft it independently and
 * concurrently; the drafts are merged so the mandate is never wider than either, and the fields
 * they disagree on are shown gray on the card. A third model then checks the card against the
 * request. A request the drafts cannot settle comes back with `ok: false` and the
 * {@link CompileError} naming the fields to ask the user about.
 */
export async function compileMandate(
  prompt: string,
  system: SystemFields,
  opts: CompileOptions = {},
): Promise<CompileResult> {
  const client = opts.client ?? new Anthropic();
  const usage: Usage[] = [];
  const message = draftMessage(prompt, system.iat, system.merchants);
  const [opus, sonnet] = (
    await Promise.allSettled([
      draft(client, "opus", OPUS_SYSTEM, message, opts, usage),
      draft(client, "sonnet", SONNET_SYSTEM, message, opts, usage),
    ])
  ).map(settled) as [Awaited<ReturnType<typeof draft>>, Awaited<ReturnType<typeof draft>>];
  opts.signal?.throwIfAborted();
  const sources: Record<Role, Source> = {
    opus: opus.source,
    sonnet: sonnet.source,
    haiku: { status: "skipped" },
  };

  let built: { mandate: Mandate; ambiguous: FieldId[]; singleSource: boolean; card: Card };
  try {
    const merged = mergeDrafts(opus.value, sonnet.value, system.merchants);
    const promptHash = `sha256:${createHash("sha256").update(prompt, "utf8").digest("hex")}`;
    const { mandate, ambiguous } = toMandate(merged.draft, system, {
      promptHash,
      ambiguous: merged.ambiguous,
    });
    const { payloadSd, disclosures } = await buildSdPayload(mandate, () =>
      crypto.getRandomValues(new Uint8Array(16)),
    );
    const card = renderCard(payloadSd, disclosures, {
      merchantSignedCheckout: false,
      zkTlsFields: new Set(),
      ambiguous: new Set(ambiguous),
    });
    built = { mandate, ambiguous, singleSource: merged.singleSource, card };
  } catch (e) {
    if (e instanceof CompileError) return { ok: false, error: e, sources, usage };
    throw e;
  }

  const verdict = await check(
    client,
    checkMessage(prompt, system.iat, cardText(built.card, built.ambiguous)),
    opts,
    usage,
  );
  sources.haiku = verdict.source;
  return {
    ok: true,
    ...built,
    discrepancies: verdict.value?.discrepancies ?? [],
    sources,
    usage,
  };
}
