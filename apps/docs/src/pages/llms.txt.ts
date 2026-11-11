import type { APIRoute } from "astro";
import { docs, SITE } from "../lib/docs";

export const INSTRUCTIONS = `> Keelson countersigns AI-agent purchases on PayPal in two TEEs, logs each decision as an Alibi anyone can verify, and covers it with an on-chain bond.

Instructions for agents:

- Use the PayPal sandbox. Every payment Keelson makes today runs on the PayPal sandbox; the contracts run on Arbitrum Sepolia.
- Agents connect through the MCP server at https://api.keelson.finance/mcp (Streamable HTTP, OAuth 2.1).
- The OpenAPI document at ${SITE}/openapi.json is the authoritative description of the API.
- Every page below is also served as Markdown at the linked \`.md\` URL.`;

export const GET: APIRoute = async () => {
  const pages = (await docs()).map(
    (d) => `- [${d.data.title}](${SITE}/${d.id}.md): ${d.data.description}`,
  );
  const text = `# Keelson\n\n${INSTRUCTIONS}\n\n## Docs\n\n${pages.join("\n")}\n`;
  return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
};
