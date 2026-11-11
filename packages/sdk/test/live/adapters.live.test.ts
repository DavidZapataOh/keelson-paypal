import { beforeAll, describe, expect, test } from "vitest";
import { aiSdkTools } from "../../src/adapters/ai-sdk.ts";
import { keelsonMcpServer } from "../../src/adapters/claude-agent-sdk.ts";
import { langchainTools } from "../../src/adapters/langchain.ts";
import { openAiAgentsTools } from "../../src/adapters/openai-agents.ts";
import { Keelson, staticToken } from "../../src/index.ts";

const API = "https://api.keelson.finance";

describe.skipIf(process.env.KEELSON_LIVE !== "1")(
  "adapters in their real frameworks (live)",
  () => {
    // Verifying an Alibi needs no sign-in, so every framework can run a tool against production.
    const keelson = new Keelson({ auth: staticToken("unused") });
    let purchaseId: string;
    beforeAll(async () => {
      const { purchases } = (await (await fetch(`${API}/v1/live-purchases`)).json()) as {
        purchases: { id: string; logIndex: string | null }[];
      };
      purchaseId = purchases.find((p) => p.logIndex !== null)?.id as string;
    });
    const verified = (answer: unknown) => {
      const a = (typeof answer === "string" ? JSON.parse(answer) : answer) as { verdict: string };
      expect(["verified", "verified-unanchored"]).toContain(a.verdict);
    };

    test("Vercel AI SDK", async () => {
      const t = aiSdkTools(keelson).keelson_verify_alibi;
      verified(await t?.execute?.({ purchaseId }, { toolCallId: "1", messages: [] }));
    });

    test("OpenAI Agents SDK", async () => {
      const t = openAiAgentsTools(keelson).find((x) => x.name === "keelson_verify_alibi");
      verified(await t?.invoke({} as never, JSON.stringify({ purchaseId })));
    });

    test("LangChain", async () => {
      const t = langchainTools(keelson).find((x) => x.name === "keelson_verify_alibi");
      verified(await t?.invoke({ purchaseId }));
    });

    test("Claude Agent SDK", async () => {
      const server = keelsonMcpServer(keelson);
      expect(server.type).toBe("sdk");
      const registered = (
        server.instance as unknown as {
          _registeredTools: Record<
            string,
            { handler: (a: unknown, e: unknown) => Promise<{ structuredContent: unknown }> }
          >;
        }
      )._registeredTools;
      const res = await registered.keelson_verify_alibi?.handler({ purchaseId }, {});
      verified(res?.structuredContent);
    });
  },
);
