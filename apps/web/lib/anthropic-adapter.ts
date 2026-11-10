import type Anthropic from "@anthropic-ai/sdk";
import { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import type {
  AgAiConversationItem,
  AgAiEvent,
  AgAiOutputItem,
  AgAiToolSchema,
  AgLlmAdapter,
  AgLlmRequest,
  AgLlmResponse,
  AgLlmResponseHandler,
} from "ag-studio";

type Json = Record<string, unknown>;
type Block = Anthropic.Messages.ContentBlockParam;

/** The property a non-object tool schema is wrapped in: Messages API tool inputs are objects. */
const WRAP = "value";

/**
 * A tool as the Messages API takes it. Studio's command schemas may be `anyOf` at the root; those
 * are wrapped in a one-property object, with `$defs` hoisted so `#/$defs/...` still resolves.
 */
function toTool(tool: AgAiToolSchema): { tool: Anthropic.Messages.Tool; wrapped: boolean } {
  const schema = tool.parameters as unknown as Json;
  if (schema.type === "object") {
    return {
      tool: {
        name: tool.name,
        description: tool.description,
        input_schema: schema as Anthropic.Messages.Tool.InputSchema,
      },
      wrapped: false,
    };
  }
  const { $defs, ...inner } = schema;
  return {
    tool: {
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: "object",
        properties: { [WRAP]: inner },
        required: [WRAP],
        ...($defs ? { $defs } : {}),
      },
    },
    wrapped: true,
  };
}

/**
 * Studio's conversation as Messages API turns. Thinking blocks are replayed unchanged from
 * `thinking`, which holds those of this page's turns; consecutive same-role messages are merged
 * by the API.
 */
function toMessages(
  items: AgAiConversationItem[],
  thinking: Map<string, Block>,
  wrapped: Set<string>,
): Anthropic.Messages.MessageParam[] {
  const messages: Anthropic.Messages.MessageParam[] = [];
  const push = (role: "user" | "assistant", block: Block) => {
    const last = messages.at(-1);
    if (last?.role === role && Array.isArray(last.content)) last.content.push(block);
    else messages.push({ role, content: [block] });
  };
  for (const item of items) {
    if (item.type === "message" && item.kind === "input") {
      for (const c of item.content) {
        if (c.type !== "text") continue;
        push("user", {
          type: "text",
          text: item.role === "system" ? `[Studio] ${c.text}` : c.text,
        });
      }
    } else if (item.type === "message") {
      for (const c of item.content) {
        const text = c.type === "text" ? c.text : c.refusal;
        if (text) push("assistant", { type: "text", text });
      }
    } else if (item.type === "reasoning") {
      const block = thinking.get(item.id);
      if (block) push("assistant", block);
    } else if (item.type === "function_call") {
      const args = JSON.parse(item.arguments || "{}") as unknown;
      push("assistant", {
        type: "tool_use",
        id: item.callId,
        name: item.name,
        input: wrapped.has(item.name) ? { [WRAP]: args } : (args as Json),
      });
    } else if (item.type === "function_call_output") {
      push("user", { type: "tool_result", tool_use_id: item.callId, content: item.output });
    }
  }
  return messages;
}

function toOutput(
  message: Anthropic.Messages.Message,
  thinking: Map<string, Block>,
  wrapped: Set<string>,
): AgAiOutputItem[] {
  return message.content.flatMap((block, i): AgAiOutputItem[] => {
    const id = `${message.id}:${i}`;
    switch (block.type) {
      case "text":
        return [
          {
            id,
            kind: "output",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "text", text: block.text, annotations: [] }],
          },
        ];
      case "thinking":
        thinking.set(id, {
          type: "thinking",
          thinking: block.thinking,
          signature: block.signature,
        });
        return [
          {
            id,
            kind: "output",
            type: "reasoning",
            summary: [{ type: "summary", text: block.thinking }],
          },
        ];
      case "tool_use": {
        const input = block.input as Json;
        return [
          {
            id: block.id,
            kind: "output",
            type: "function_call",
            callId: block.id,
            name: block.name,
            arguments: JSON.stringify(wrapped.has(block.name) ? input[WRAP] : input),
            status: "completed",
          },
        ];
      }
      case "redacted_thinking":
        thinking.set(id, { type: "redacted_thinking", data: block.data });
        return [{ id, kind: "output", type: "reasoning", summary: [] }];
      default:
        return [];
    }
  });
}

/** Translates the Messages API stream into Studio's AG-UI content events. */
async function* events(
  stream: MessageStream,
  wrapped: Set<string>,
): AsyncIterableIterator<AgAiEvent> {
  let messageId = "";
  const open = new Map<number, { kind: "text" | "thinking" | "tool"; id: string; name?: string }>();
  for await (const event of stream) {
    if (event.type === "message_start") {
      messageId = event.message.id;
    } else if (event.type === "content_block_start") {
      const id = `${messageId}:${event.index}`;
      const block = event.content_block;
      if (block.type === "text") {
        open.set(event.index, { kind: "text", id });
        yield { type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" } as AgAiEvent;
      } else if (block.type === "thinking") {
        open.set(event.index, { kind: "thinking", id });
        yield { type: "REASONING_MESSAGE_START", messageId: id, role: "reasoning" } as AgAiEvent;
      } else if (block.type === "tool_use") {
        open.set(event.index, { kind: "tool", id: block.id, name: block.name });
        yield {
          type: "TOOL_CALL_START",
          toolCallId: block.id,
          toolCallName: block.name,
        } as AgAiEvent;
      }
    } else if (event.type === "content_block_delta") {
      const b = open.get(event.index);
      if (!b) continue;
      const d = event.delta;
      if (d.type === "text_delta") {
        yield { type: "TEXT_MESSAGE_CONTENT", messageId: b.id, delta: d.text } as AgAiEvent;
      } else if (d.type === "thinking_delta" && d.thinking) {
        yield {
          type: "REASONING_MESSAGE_CONTENT",
          messageId: b.id,
          delta: d.thinking,
        } as AgAiEvent;
      } else if (d.type === "input_json_delta" && b.name && !wrapped.has(b.name)) {
        yield { type: "TOOL_CALL_ARGS", toolCallId: b.id, delta: d.partial_json } as AgAiEvent;
      }
    } else if (event.type === "content_block_stop") {
      const b = open.get(event.index);
      if (!b) continue;
      if (b.kind === "text") yield { type: "TEXT_MESSAGE_END", messageId: b.id } as AgAiEvent;
      else if (b.kind === "thinking")
        yield { type: "REASONING_MESSAGE_END", messageId: b.id } as AgAiEvent;
      else {
        if (b.name && wrapped.has(b.name)) {
          const block = stream.currentMessage?.content[event.index];
          const input = block?.type === "tool_use" ? (block.input as Json)[WRAP] : undefined;
          yield {
            type: "TOOL_CALL_ARGS",
            toolCallId: b.id,
            delta: JSON.stringify(input ?? {}),
          } as AgAiEvent;
        }
        yield { type: "TOOL_CALL_END", toolCallId: b.id } as AgAiEvent;
      }
    }
  }
}

export interface AnthropicAdapterOptions {
  /** The proxy route a turn is posted to, with the session cookie. */
  endpoint: string;
  /** Told which model answered, when the proxy fell back to another once a budget was spent. */
  onModel?: (model: string) => void;
}

/**
 * An `AgLlmAdapter` for the Messages API, through Keelson's proxy: the proxy holds the key, the
 * budget and the limits; this side translates Studio's turns and the streamed reply.
 */
export function anthropicAdapter(options: AnthropicAdapterOptions): AgLlmAdapter {
  const thinking = new Map<string, Block>();
  return {
    executeTurn(request: AgLlmRequest, opts?: { signal?: AbortSignal }): AgLlmResponseHandler {
      const converted = (request.tools ?? []).map(toTool);
      const wrapped = new Set(converted.filter((t) => t.wrapped).map((t) => t.tool.name));
      const body = {
        model: request.model?.id,
        system: request.instructions ?? "",
        messages: toMessages(request.input, thinking, wrapped),
        tools: converted.map((t) => t.tool),
        ...(request.toolChoice === "none" ? { tool_choice: "none" } : {}),
      };
      let resolve!: (r: AgLlmResponse) => void;
      let reject!: (e: Error) => void;
      const complete = new Promise<AgLlmResponse>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      void complete.catch(() => {});
      async function* run(): AsyncIterableIterator<AgAiEvent> {
        try {
          const res = await fetch(options.endpoint, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            ...(opts?.signal ? { signal: opts.signal } : {}),
          });
          if (!res.ok || !res.body) {
            const problem = (await res.json().catch(() => ({}))) as { detail?: string };
            throw new Error(problem.detail ?? `The assistant answered ${res.status}.`);
          }
          const model = res.headers.get("keelson-model");
          if (model) options.onModel?.(model);
          const stream = MessageStream.fromReadableStream(res.body);
          yield* events(stream, wrapped);
          const message = await stream.finalMessage();
          resolve({
            id: message.id,
            createdAt: Date.now(),
            model: message.model,
            status: message.stop_reason === "max_tokens" ? "incomplete" : "completed",
            output: toOutput(message, thinking, wrapped),
            usage: {
              inputTokens: message.usage.input_tokens,
              outputTokens: message.usage.output_tokens,
              ...(message.usage.cache_read_input_tokens != null
                ? { cachedInputTokens: message.usage.cache_read_input_tokens }
                : {}),
              ...(message.usage.cache_creation_input_tokens != null
                ? { cacheWriteTokens: message.usage.cache_creation_input_tokens }
                : {}),
            },
          });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
      const iterator = run();
      return { stream: { [Symbol.asyncIterator]: () => iterator }, complete };
    },
  };
}
