import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import corpus from "./corpus.json" with { type: "json" };

interface Doc {
  source: string;
  language: string;
  title: string;
  text: string;
}
interface Operation {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  scopes: string[];
  typescript: string | null;
  python: string | null;
}

const docs = corpus.docs as Doc[];
const operations = corpus.operations as Operation[];
const schemas = corpus.schemas as Record<string, unknown>;

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);

/** How many of the query's words a text holds, title words counting twice. */
function score(query: string, title: string, text: string): number {
  const q = words(query);
  const t = words(title);
  const b = words(text);
  let n = 0;
  for (const w of q) n += (t.has(w) ? 2 : 0) + (b.has(w) ? 1 : 0);
  return n;
}

const Language = z.enum(["typescript", "python"]);

const json = (value: Record<string, unknown>, text: string) => ({
  content: [{ type: "text" as const, text: `${text}\n${JSON.stringify(value)}` }],
  structuredContent: value,
});

/**
 * The Keelson Context Plugin: Keelson's SDK docs, its 22 developer operations and their schemas,
 * for AI coding assistants. Read-only; it calls nothing.
 */
export function createContextServer(): McpServer {
  const server = new McpServer(
    {
      name: "keelson-docs",
      title: "Keelson Context Plugin",
      version: "0.1.1",
      websiteUrl: "https://keelson.finance",
    },
    {
      instructions:
        "Docs for building with Keelson's SDKs (@keelson-finance/sdk for TypeScript, keelson-finance for Python). Start with the integrate_keelson prompt, then search_docs and get_operation for exact calls.",
    },
  );

  server.registerTool(
    "search_docs",
    {
      title: "Search Keelson's SDK docs",
      description:
        "Finds the sections of Keelson's SDK docs and examples that answer a question, with their code. Use it before writing code against Keelson.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(500)
          .describe("What you want to do, e.g. 'verify an Alibi offline'."),
        language: Language.optional(),
      }),
      outputSchema: z.object({
        matches: z.array(
          z.object({
            title: z.string(),
            source: z.string(),
            language: z.string(),
            text: z.string(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, language }) => {
      const matches = docs
        .filter((d) => !language || d.language === language || d.language === "any")
        .map((d) => ({ d, s: score(query, d.title, d.text) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 4)
        .map(({ d }) => ({ title: d.title, source: d.source, language: d.language, text: d.text }));
      return json(
        { matches },
        matches.length ? `${matches.length} sections match.` : "Nothing matches.",
      );
    },
  );

  server.registerTool(
    "get_operation",
    {
      title: "Get an API operation",
      description:
        "One of Keelson's developer operations: method, path, what it does, the OAuth scopes it needs, and the SDK call for it in TypeScript or Python. Name it by operationId or describe it.",
      inputSchema: z.object({
        operationId: z.string().optional().describe("e.g. 'countersign'"),
        query: z.string().optional().describe("e.g. 'ask the user for a mandate'"),
        language: Language.optional(),
      }),
      outputSchema: z.object({
        matches: z.array(
          z.object({
            operationId: z.string(),
            method: z.string(),
            path: z.string(),
            summary: z.string(),
            description: z.string(),
            scopes: z.array(z.string()),
            snippet: z.string().nullable(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ operationId, query, language = "typescript" }) => {
      const ranked = operationId
        ? operations.filter((o) => o.operationId === operationId)
        : operations
            .map((o) => ({
              o,
              s: score(query ?? "", `${o.operationId} ${o.summary}`, `${o.path} ${o.description}`),
            }))
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s)
            .slice(0, 3)
            .map((x) => x.o);
      const matches = ranked.map((o) => ({
        operationId: o.operationId,
        method: o.method,
        path: o.path,
        summary: o.summary,
        description: o.description,
        scopes: o.scopes,
        snippet: language === "python" ? o.python : o.typescript,
      }));
      return json(
        { matches },
        matches.map((m) => `${m.method} ${m.path} (${m.operationId})`).join("\n") ||
          "Nothing matches.",
      );
    },
  );

  server.registerTool(
    "get_schema",
    {
      title: "Get a schema",
      description:
        "A request or response schema of Keelson's API as JSON Schema, e.g. Cart, Purchase, OperatorMandate, AlibiReceipt. The SDKs export the same names as types.",
      inputSchema: z.object({ name: z.string().min(1) }),
      outputSchema: z.object({
        name: z.string(),
        schema: z.unknown().nullable(),
        names: z.array(z.string()),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ name }) => {
      const schema = schemas[name] ?? null;
      return json(
        { name, schema, names: Object.keys(schemas) },
        schema ? `Schema ${name}.` : `No schema ${name}; see names.`,
      );
    },
  );

  server.registerPrompt(
    "integrate_keelson",
    {
      title: "Integrate Keelson",
      description: "How to add Keelson to an app or an agent, step by step, with code.",
      argsSchema: z.object({ language: Language, role: z.enum(["app", "operator"]) }),
    },
    ({ language, role }) => {
      const py = language === "python";
      const install = py
        ? "pip install keelson-finance\nkeelson login"
        : "npm install @keelson-finance/sdk @keelson-finance/verifier\nnpx @keelson-finance/sdk login";
      const auth =
        role === "operator"
          ? "Set KEELSON_CLIENT_ID, KEELSON_CLIENT_SECRET (client credentials) and KEELSON_AGENT_KEY (the agent's private P-256 JWK): the client closes every mandate with that key."
          : `Sign in once with \`${py ? "keelson login" : "npx @keelson-finance/sdk login"}\`; ${py ? "Keelson()" : "new Keelson()"} reads the saved sign-in. Keelson's hosted operator closes mandates for you, up to $100 per user for an app it does not know.`;
      const quickstart = docs.find(
        (d) => d.title === (py ? "Quickstart (Python)" : "Quickstart (TypeScript)"),
      );
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Integrate Keelson into this ${role === "operator" ? "operator's agent" : "app"} in ${py ? "Python" : "TypeScript"}. Everything runs on the PayPal sandbox and Arbitrum Sepolia.`,
                `1. Install and sign in:\n${install}`,
                `2. Authentication: ${auth}`,
                `3. Ask the user for a mandate (${py ? "mandates.request" : "mandates.request"}) and show them approvalUrl; then ${py ? "mandates.wait_for_approval" : "waitForApproval"} until they sign with their passkey and hold the budget on PayPal.`,
                "4. Price the cart from the store, seal what the agent saw (evidence.seal), then purchases.countersign. Never resend a countersign after OutcomeUnknownError: wait for the purchase instead.",
                "5. Verify the Alibi offline (verifyAlibi / verify_alibi) and show the verdict.",
                `The whole flow:\n${quickstart?.text ?? ""}`,
                "Use the search_docs, get_operation and get_schema tools for exact calls and types.",
              ].join("\n\n"),
            },
          },
        ],
      };
    },
  );

  return server;
}
