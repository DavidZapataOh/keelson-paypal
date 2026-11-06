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

/** The longest request, in UTF-16 code units, that a compile spends model calls on. */
export const MAX_PROMPT_CHARS = 2000;

export type FailReason = "timeout" | "aborted" | "api_error" | "max_tokens" | "invalid_output";

/** How one model call ended. A refused or failed compiler model counts as missing. */
export type Source =
  | { status: "ok" }
  | { status: "refused"; category: string | null }
  | { status: "failed"; reason: FailReason }
  | { status: "skipped" };

/**
 * The round trip of the card against the request. Only `ok` means the card was checked;
 * otherwise `discrepancies` is null and the card must be presented as not checked.
 */
export type Check =
  | { status: "ok"; discrepancies: Discrepancy[] }
  | { status: "refused" | "failed" | "aborted" | "skipped"; discrepancies: null };

export interface Usage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  ms: number;
}

export type CompileResult = {
  sources: Record<Role, Source>;
  check: Check;
  usage: Usage[];
} & (
  | {
      ok: true;
      mandate: Mandate;
      card: Card;
      ambiguous: FieldId[];
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
  maxRetries?: number;
  maxTokens?: number;
}

export interface CompileOptions {
  client?: Anthropic;
  signal?: AbortSignal;
  limits?: Partial<Record<Role, Limits>>;
}

const MAX_TOKENS = 16000;
const TIMEOUT_MS = 20_000;
const MAX_RETRIES = 1;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type Reply = Anthropic.Message | Anthropic.Beta.BetaMessage;

type Outcome<T> = { source: Source; value: T | null };

const failed = (reason: FailReason) =>
  ({ source: { status: "failed", reason }, value: null }) as const;

/** The final text of a reply: the text after the last fallback switch point. */
function finalText(content: Reply["content"]): string | undefined {
  const blocks: readonly { type: string }[] = content;
  const tail = blocks.slice(blocks.findLastIndex((b) => b.type === "fallback") + 1);
  const texts = tail.flatMap((b) => (b.type === "text" ? [(b as Anthropic.TextBlock).text] : []));
  return texts.length ? texts.join("") : undefined;
}

/**
 * Classifies a reply. `stop_reason` is checked before the structured output is parsed, since a
 * refused or cut-off reply need not match the schema; any parse failure is `invalid_output`.
 */
export function outcome<T>(reply: Reply, parse: (content: string) => T): Outcome<T> {
  if (reply.stop_reason === "refusal") {
    return {
      source: { status: "refused", category: reply.stop_details?.category ?? null },
      value: null,
    };
  }
  if (reply.stop_reason === "max_tokens") return failed("max_tokens");
  if (reply.stop_reason !== "end_turn") return failed("invalid_output");
  const text = finalText(reply.content);
  if (text === undefined) return failed("invalid_output");
  try {
    return { source: { status: "ok" }, value: parse(text) };
  } catch {
    return failed("invalid_output");
  }
}

/** The usage of one reply, cache reads and writes included. */
export function usageOf(reply: Reply, ms: number): Usage {
  return {
    model: reply.model,
    input: reply.usage.input_tokens,
    output: reply.usage.output_tokens,
    cacheRead: reply.usage.cache_read_input_tokens ?? 0,
    cacheWrite: reply.usage.cache_creation_input_tokens ?? 0,
    ms,
  };
}

/** Runs one model call; every way it can end is a typed outcome, never a rejection. */
async function run<T>(
  role: Role,
  parse: (content: string) => T,
  send: (options: Anthropic.RequestOptions) => Promise<Reply>,
  opts: CompileOptions,
  usage: Usage[],
): Promise<Outcome<T>> {
  const limits = opts.limits?.[role];
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  let reply: Reply;
  try {
    reply = await send({
      timeout: limits?.timeout ?? TIMEOUT_MS,
      maxRetries: limits?.maxRetries ?? MAX_RETRIES,
      signal: opts.signal,
    });
  } catch (e) {
    usage.push({
      model: MODELS[role],
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      ms: elapsed(),
    });
    if (e instanceof Anthropic.APIConnectionTimeoutError) return failed("timeout");
    if (e instanceof Anthropic.APIUserAbortError || opts.signal?.aborted) return failed("aborted");
    return failed("api_error");
  }
  usage.push(usageOf(reply, elapsed()));
  return outcome(reply, parse);
}

/** A system prompt cached across calls: it and the output schema are the stable prefix. */
const cached = (text: string) => [
  { type: "text" as const, text, cache_control: { type: "ephemeral" as const } },
];

function draft(
  client: Anthropic,
  role: "opus" | "sonnet",
  system: string,
  content: string,
  opts: CompileOptions,
  usage: Usage[],
): Promise<Outcome<Draft>> {
  const format = betaZodOutputFormat(DraftSchema);
  return run(
    role,
    format.parse,
    (options) =>
      client.beta.messages.create(
        {
          model: MODELS[role],
          max_tokens: opts.limits?.[role]?.maxTokens ?? MAX_TOKENS,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          system: cached(system),
          messages: [{ role: "user", content }],
          output_config: { effort: "high", format },
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
    format.parse,
    (options) =>
      client.messages.create(
        {
          model: MODELS.haiku,
          max_tokens: opts.limits?.haiku?.maxTokens ?? MAX_TOKENS,
          system: cached(HAIKU_SYSTEM),
          messages: [{ role: "user", content }],
          output_config: { effort: "low", format },
        },
        options,
      ),
    opts,
    usage,
  );
}

const SKIPPED: Source = { status: "skipped" };

/**
 * Compiles a natural-language request into a mandate. Two models draft it independently and
 * concurrently; the drafts are merged so the mandate is never wider than either, and the fields
 * they disagree on are shown gray on the card. A third model then checks the card against the
 * request. Nothing a model does makes this reject: a request that cannot become a mandate,
 * including one over {@link MAX_PROMPT_CHARS} or an aborted compile, comes back with `ok: false`
 * and the {@link CompileError} naming the fields to ask the user about.
 */
export async function compileMandate(
  prompt: string,
  system: SystemFields,
  opts: CompileOptions = {},
): Promise<CompileResult> {
  const usage: Usage[] = [];
  const sources: Record<Role, Source> = { opus: SKIPPED, sonnet: SKIPPED, haiku: SKIPPED };
  const stop = (error: CompileError): CompileResult => ({
    ok: false,
    error,
    sources,
    check: { status: "skipped", discrepancies: null },
    usage,
  });
  if (prompt.length > MAX_PROMPT_CHARS) return stop(new CompileError("prompt_too_long"));

  const client = opts.client ?? new Anthropic();
  const message = draftMessage(prompt, system.iat, system.merchants);
  const [opus, sonnet] = (
    await Promise.allSettled([
      draft(client, "opus", OPUS_SYSTEM, message, opts, usage),
      draft(client, "sonnet", SONNET_SYSTEM, message, opts, usage),
    ])
  ).map((r) => (r.status === "fulfilled" ? r.value : failed("api_error"))) as [
    Outcome<Draft>,
    Outcome<Draft>,
  ];
  sources.opus = opus.source;
  sources.sonnet = sonnet.source;
  if (opts.signal?.aborted) return stop(new CompileError("aborted"));

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
    if (e instanceof CompileError) return stop(e);
    throw e;
  }

  const verdict = await check(
    client,
    checkMessage(prompt, system.iat, cardText(built.card, built.ambiguous)),
    opts,
    usage,
  );
  sources.haiku = verdict.source;
  return { ok: true, ...built, check: toCheck(verdict), sources, usage };
}

function toCheck(verdict: Outcome<{ discrepancies: Discrepancy[] }>): Check {
  const { source, value } = verdict;
  if (source.status === "ok" && value) return { status: "ok", discrepancies: value.discrepancies };
  if (source.status === "failed" && source.reason === "aborted") {
    return { status: "aborted", discrepancies: null };
  }
  return {
    status: source.status === "refused" ? "refused" : "failed",
    discrepancies: null,
  };
}
