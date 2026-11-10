// Links the agent's `cnf` key to its ERC-8004 identity: the agent's owner signs `OperatorLink`
// and the agent posts it to `POST /v1/operators` with its own OAuth client.
//
//   KEELSON_AGENT_KEY       the agent's private P-256 JWK (scripts/agent-key.ts)
//   OPERATOR_OWNER_KEY      the private key of the agent's owner or agentWallet, 0x-hex
//   AGENT_ID                the ERC-8004 agent id; CHAIN_ID defaults to 421614
//   KEELSON_CLIENT_ID, KEELSON_CLIENT_SECRET   an OAuth client with `operators:write`
//   KEELSON_API_URL         defaults to https://api.keelson.finance
import { type Erc8004ChainId, OPERATOR_LINK_TYPES, operatorLinkDomain } from "@keelson/erc8004";
import { calculateJwkThumbprint } from "jose";
import { type Hex, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentKey, apiClient } from "../src/keelson.ts";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const chainId = Number(process.env.CHAIN_ID ?? 421614) as Erc8004ChainId;
const agentId = BigInt(env("AGENT_ID"));
const { publicJwk } = await agentKey(env("KEELSON_AGENT_KEY"));
const thumbprint = await calculateJwkThumbprint(publicJwk, "sha256");
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
const signature = await privateKeyToAccount(env("OPERATOR_OWNER_KEY") as Hex).signTypedData({
  domain: operatorLinkDomain(chainId),
  types: OPERATOR_LINK_TYPES,
  primaryType: "OperatorLink",
  message: {
    agentId,
    cnfThumbprint: toHex(Buffer.from(thumbprint, "base64url")),
    deadline,
  },
});
const keelson = apiClient({
  apiUrl: process.env.KEELSON_API_URL ?? "https://api.keelson.finance",
  clientId: env("KEELSON_CLIENT_ID"),
  clientSecret: env("KEELSON_CLIENT_SECRET"),
  scopes: ["operators:write"],
});
const res = await keelson.request("/v1/operators", {
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
  body: JSON.stringify({
    chainId,
    agentId: agentId.toString(),
    name: process.env.OPERATOR_NAME ?? "Keelson shopping agent",
    cnfJwk: publicJwk,
    deadline: Number(deadline),
    signature,
  }),
});
console.log(res.status, JSON.stringify(await res.json()));
if (!res.ok) process.exitCode = 1;
