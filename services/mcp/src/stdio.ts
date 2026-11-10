#!/usr/bin/env node
// Keelson's MCP server over STDIO, for a host that runs it as the agent's own process. It calls
// Keelson's API as the agent's OAuth client and holds the agent's `cnf` key, so it alone offers
// keelson.request_countersign.
//
//   KEELSON_CLIENT_ID, KEELSON_CLIENT_SECRET   the agent's OAuth client (client credentials)
//   KEELSON_AGENT_KEY                          optional: the private P-256 JWK the mandates name
//   AGENT_ID                                   optional: the operator's ERC-8004 agent id
//   KEELSON_API_URL, KEELSON_APP_URL, STORE_URL
import { agentKey, apiClient } from "@keelson/agent/keelson";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createKeelsonServer } from "./server.ts";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const server = createKeelsonServer({
  keelson: apiClient({
    apiUrl: process.env.KEELSON_API_URL ?? "https://api.keelson.finance",
    clientId: env("KEELSON_CLIENT_ID"),
    clientSecret: env("KEELSON_CLIENT_SECRET"),
    scopes: (process.env.KEELSON_SCOPES ?? "countersign:write evidence:write alibis:read").split(
      " ",
    ),
  }),
  appOrigin: process.env.KEELSON_APP_URL ?? "https://app.keelson.finance",
  storeOrigin: process.env.STORE_URL ?? "https://store.keelson.finance",
  agentId: process.env.AGENT_ID ? BigInt(process.env.AGENT_ID) : undefined,
  agentKey: process.env.KEELSON_AGENT_KEY
    ? (await agentKey(process.env.KEELSON_AGENT_KEY)).privateKey
    : undefined,
});
await server.connect(new StdioServerTransport());
