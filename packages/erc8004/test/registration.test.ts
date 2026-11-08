import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { operatorRegistration, REGISTRATION_TYPE, RegistrationFile } from "../src/index.ts";

/** The registration file of EIP-8004 ("Agent URI and Agent Registration File"), as JSON Schema. */
const registrationSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: [
    "type",
    "name",
    "description",
    "image",
    "services",
    "x402Support",
    "active",
    "registrations",
  ],
  properties: {
    type: { const: REGISTRATION_TYPE },
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    image: { type: "string" },
    services: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "endpoint"],
        properties: {
          name: { type: "string" },
          endpoint: { type: "string" },
          version: { type: "string" },
          skills: { type: "array" },
          domains: { type: "array" },
        },
      },
    },
    x402Support: { type: "boolean" },
    active: { type: "boolean" },
    registrations: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["agentId", "agentRegistry"],
        additionalProperties: false,
        properties: {
          agentId: { type: ["integer", "string"] },
          agentRegistry: { type: "string", pattern: "^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:.+$" },
        },
      },
    },
    supportedTrust: { type: "array", items: { type: "string" } },
  },
} as const;

const validate = new Ajv2020({ strict: true, allowUnionTypes: true }).compile(registrationSchema);

/** The example registration file of the ERC, without its comments. */
const ercExample = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "myAgentName",
  description:
    "A natural language description of the Agent, which MAY include what it does, how it works, pricing, and interaction methods",
  image: "https://example.com/agentimage.png",
  services: [
    { name: "web", endpoint: "https://web.agentxyz.com/" },
    {
      name: "A2A",
      endpoint: "https://agent.example/.well-known/agent-card.json",
      version: "0.3.0",
    },
    { name: "MCP", endpoint: "https://mcp.agent.eth/", version: "2025-06-18" },
    { name: "OASF", endpoint: "ipfs://{cid}", version: "0.8", skills: [], domains: [] },
    { name: "ENS", endpoint: "vitalik.eth", version: "v1" },
    { name: "DID", endpoint: "did:method:foobar", version: "v1" },
    { name: "email", endpoint: "mail@myagent.com" },
  ],
  x402Support: false,
  active: true,
  registrations: [
    { agentId: 22, agentRegistry: "eip155:1:0x742d35Cc6634C0532925a3b844Bc454e4438f44e" },
  ],
  supportedTrust: ["reputation", "crypto-economic", "tee-attestation"],
};

describe("RegistrationFile", () => {
  test("accepts the ERC's example, as the JSON Schema does", () => {
    expect(validate(ercExample)).toBe(true);
    expect(RegistrationFile.parse(ercExample)).toEqual(ercExample);
  });

  test("requires at least one registration with both fields", () => {
    for (const registrations of [[], [{ agentId: 22 }]]) {
      const file = { ...ercExample, registrations };
      expect(validate(file)).toBe(false);
      expect(RegistrationFile.safeParse(file).success).toBe(false);
    }
  });
});

describe("operatorRegistration", () => {
  const file = operatorRegistration({
    name: "Acme shopping agent",
    description: "Buys on behalf of Acme users.",
    image: "https://keelson.finance/icon-512.png",
    registrations: [
      { chainId: 421614, agentId: 351n },
      { chainId: 42161, agentId: 2n ** 70n },
    ],
  });

  test("is a valid registration file", () => {
    expect(validate(file)).toBe(true);
    expect(RegistrationFile.parse(file)).toEqual(file);
  });

  test("lists one bond service and one registration per agent", () => {
    expect(file.services).toEqual([
      {
        name: "keelson-bond",
        endpoint: "https://api.keelson.finance/v1/operators/421614/351/bond",
        version: "1",
      },
      {
        name: "keelson-bond",
        endpoint: `https://api.keelson.finance/v1/operators/42161/${2n ** 70n}/bond`,
        version: "1",
      },
    ]);
    expect(file.registrations).toEqual([
      { agentId: 351, agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e" },
      {
        agentId: (2n ** 70n).toString(),
        agentRegistry: "eip155:42161:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      },
    ]);
  });

  test("states the trust models and the draft status", () => {
    expect(file.supportedTrust).toEqual(["reputation", "crypto-economic", "tee-attestation"]);
    expect(file.x402Support).toBe(false);
    expect(file.active).toBe(true);
    expect(file.description).toBe(
      "Buys on behalf of Acme users. ERC-8004 is a Draft standard; Keelson pins v2.0.0.",
    );
  });
});
