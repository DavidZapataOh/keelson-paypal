import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { ALIBI_FILE, type ResponsePlan } from "./evidence.ts";

const DRAFTER = "claude-opus-5-5";
const FORMATTER = "claude-haiku-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const TIMEOUT_MS = 90_000;
/** PayPal's `notes` and message `content` limit. */
export const NOTE_MAX = 2_000;

const SYSTEM = `You write a merchant's statement for the PayPal agent reviewing a customer dispute.
The party at fault was already determined by a deterministic attribution over signed records; the finding you are given is final. Support that finding only: do not weigh fault yourself, do not concede, do not speculate.
State only facts that appear in the documents, and cite them. The Alibi is the purchase's signed record: the buyer's mandate, the cart the agent proposed, the two-party countersignature, the transparency-log inclusion and timestamps. The Verdict is the attribution.
Write plain prose for a human reviewer: no markdown, no headings, no lists, under 1,500 characters. Leave out email addresses, postal addresses and keys.`;

const FORMAT_SYSTEM = `You fit a merchant's dispute statement into the fields of a PayPal request.
Write one note per field. Each note must stand alone, be plain text under 1,800 characters, and use only facts and quotes from the statement and its sources. Keep each note on what its field shows. Do not add claims, opinions or apologies.`;

/** What each field of PayPal's request shows, for the formatter. */
const FIELD_PURPOSE: Readonly<Record<string, string>> = {
  PERMISSION_DESCRIPTION: "the buyer authorized this purchase through the mandate they signed",
  ORDER_DETAILS: "what was ordered, for how much, and the attached Alibi PDF that proves it",
  ONLINE_TRACKING_INFORMATION: "the carrier's tracking shows the item delivered",
  PROOF_OF_REFUND: "the refund already issued for this purchase",
  message: "a message to the buyer and PayPal answering the inquiry, with the Alibi attached",
};

export type DraftFailure =
  | "refused"
  | "uncited"
  | "timeout"
  | "api_error"
  | "max_tokens"
  | "invalid_output";

/** The tokens and wall time one model call used. */
export interface DraftUsage {
  model: string;
  input: number;
  output: number;
  ms: number;
}

export interface Citation {
  text: string;
  document: string;
  pages?: [number, number];
}

export interface Draft {
  /** `model` when both calls answered; otherwise the rule's fixed statement was used. */
  source: "model" | "template";
  failure?: DraftFailure;
  statement: string;
  citations: Citation[];
  /** One note per field: an `evidence_type`, or `message` for an inquiry. */
  notes: Record<string, string>;
  usage: DraftUsage[];
}

export interface DraftInput {
  plan: Extract<ResponsePlan, { action: "contest" }>;
  step: "provide_evidence" | "send_message";
  dispute: { id: string; reason: string; amount?: string | undefined };
  /** The rule, the verdict digest and the facts, as stored. */
  verdict: { rule: string; digest: string; facts: Record<string, unknown> };
  alibiPdf: Uint8Array;
  trackers?: string[];
}

type Reply = Anthropic.Beta.BetaMessage | Anthropic.Message;

/** The fields the request fills: the planned evidence types, or the inquiry message. */
export const fieldsOf = (input: Pick<DraftInput, "plan" | "step">): string[] =>
  input.step === "send_message" ? ["message"] : input.plan.evidences.map((e) => e.evidence_type);

/** The rule's fixed statement, used when the model does not produce a grounded one. */
export function templateNotes(input: DraftInput): Record<string, string> {
  const { plan, verdict } = input;
  const tracking = input.trackers?.length
    ? ` PayPal tracker ids: ${input.trackers.join(", ")}.`
    : "";
  const text = `${plan.finding}${tracking} The attached ${ALIBI_FILE} is the purchase's Alibi: the mandate the buyer signed, the cart the agent proposed, its two-party countersignature and its inclusion in a public transparency log. Attribution ${verdict.rule}, verdict ${verdict.digest}.`;
  return Object.fromEntries(fieldsOf(input).map((f) => [f, text.slice(0, NOTE_MAX)]));
}

/** The final text of a reply with its citations, after the last fallback switch point. */
export function citedText(content: Reply["content"]): { text: string; citations: Citation[] } {
  const blocks: readonly { type: string }[] = content;
  const tail = blocks.slice(blocks.findLastIndex((b) => b.type === "fallback") + 1);
  let text = "";
  const citations: Citation[] = [];
  for (const b of tail) {
    if (b.type !== "text") continue;
    const block = b as Anthropic.Beta.BetaTextBlock;
    text += block.text;
    for (const c of block.citations ?? []) {
      if (!("cited_text" in c) || !("document_title" in c)) continue;
      citations.push({
        text: c.cited_text,
        document: c.document_title ?? `document ${"document_index" in c ? c.document_index : "?"}`,
        ...(c.type === "page_location" ? { pages: [c.start_page_number, c.end_page_number] } : {}),
      });
      text += `[${citations.length}]`;
    }
  }
  return { text: text.trim(), citations };
}

/** The statement and its numbered sources, as the formatter reads them. */
export function withSources(statement: string, citations: Citation[]): string {
  const sources = citations.map(
    (c, i) =>
      `[${i + 1}] ${c.document}${c.pages ? ` p.${c.pages[0]}` : ""}: "${c.text.replace(/\s+/g, " ").trim()}"`,
  );
  return `${statement}\n\nSources:\n${sources.join("\n")}`;
}

/** Why a reply is unusable, checked before its content is read. */
export function failureOf(reply: Reply): DraftFailure | null {
  if (reply.stop_reason === "refusal") return "refused";
  if (reply.stop_reason === "max_tokens") return "max_tokens";
  if (reply.stop_reason !== "end_turn") return "invalid_output";
  return null;
}

function failureOfError(e: unknown): DraftFailure {
  return e instanceof Anthropic.APIConnectionTimeoutError ? "timeout" : "api_error";
}

async function timed<T extends Reply>(
  usage: DraftUsage[],
  model: string,
  send: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  const ms = () => Math.round(performance.now() - start);
  try {
    const reply = await send();
    usage.push({
      model: reply.model,
      input: reply.usage.input_tokens,
      output: reply.usage.output_tokens,
      ms: ms(),
    });
    return reply;
  } catch (e) {
    usage.push({ model, input: 0, output: 0, ms: ms() });
    throw e;
  }
}

function verdictDocument(input: DraftInput): string {
  const { dispute, verdict, plan } = input;
  const facts = Object.entries(verdict.facts)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join("\n");
  return `PayPal dispute ${dispute.id}
Reason: ${dispute.reason}${dispute.amount ? `\nDisputed amount: ${dispute.amount}` : ""}
Attribution rule: ${verdict.rule}
Party at fault: ${plan.party}
Finding: ${plan.finding}
Verdict digest (signed by both TEE legs): ${verdict.digest}
Facts the attribution was computed on:
${facts}`;
}

/**
 * Drafts the response to a contested dispute in two calls, since Citations and structured
 * outputs cannot be combined: Opus writes a statement citing the Alibi and the verdict, then
 * Haiku fits it into PayPal's fields. The action and the fields are the plan's; the models only
 * write. Any failure, or a statement without citations, falls back to the rule's fixed text.
 */
export async function draftResponse(client: Anthropic, input: DraftInput): Promise<Draft> {
  const usage: DraftUsage[] = [];
  const fields = fieldsOf(input);
  const fallback = (failure: DraftFailure, statement = "", citations: Citation[] = []): Draft => ({
    source: "template",
    failure,
    statement,
    citations,
    notes: templateNotes(input),
    usage,
  });

  let draft: Anthropic.Beta.BetaMessage;
  try {
    draft = await timed(usage, DRAFTER, () =>
      client.beta.messages.create(
        {
          model: DRAFTER,
          max_tokens: 16_000,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          system: SYSTEM,
          output_config: { effort: "high" },
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "document",
                  title: "Alibi",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: Buffer.from(input.alibiPdf).toString("base64"),
                  },
                  citations: { enabled: true },
                },
                {
                  type: "document",
                  title: "Verdict",
                  source: { type: "text", media_type: "text/plain", data: verdictDocument(input) },
                  citations: { enabled: true },
                },
                {
                  type: "text",
                  text: `Write the statement for dispute ${input.dispute.id}. It will accompany: ${fields.map((f) => FIELD_PURPOSE[f] ?? f).join("; ")}.`,
                },
              ],
            },
          ],
        },
        { timeout: TIMEOUT_MS, maxRetries: 1 },
      ),
    );
  } catch (e) {
    return fallback(failureOfError(e));
  }
  const drafted = failureOf(draft);
  if (drafted) return fallback(drafted);
  const { text: statement, citations } = citedText(draft.content);
  if (citations.length === 0 || statement.length === 0) {
    return fallback("uncited", statement);
  }

  const format = zodOutputFormat(
    z.object({
      notes: z.object(Object.fromEntries(fields.map((f) => [f, z.string().min(1).max(NOTE_MAX)]))),
    }),
  );
  let shaped: Anthropic.Message;
  try {
    shaped = await timed(usage, FORMATTER, () =>
      client.messages.create(
        {
          model: FORMATTER,
          max_tokens: 8_000,
          system: FORMAT_SYSTEM,
          output_config: { effort: "low", format },
          messages: [
            {
              role: "user",
              content: `Fields:\n${fields.map((f) => `- ${f}: ${FIELD_PURPOSE[f] ?? f}`).join("\n")}\n\nStatement:\n${withSources(statement, citations)}`,
            },
          ],
        },
        { timeout: TIMEOUT_MS, maxRetries: 1 },
      ),
    );
  } catch (e) {
    return fallback(failureOfError(e), statement, citations);
  }
  const formatted = failureOf(shaped);
  if (formatted) return fallback(formatted, statement, citations);
  try {
    const text = shaped.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const { notes } = format.parse(text) as { notes: Record<string, string> };
    return { source: "model", statement, citations, notes, usage };
  } catch {
    return fallback("invalid_output", statement, citations);
  }
}
