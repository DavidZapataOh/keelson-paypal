import { randomBytes } from "node:crypto";
import { addresses } from "@keelson/chain";
import { operators } from "@keelson/db";
import { MandateSchema, TERMS_HASH } from "@keelson/mandate";
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";
import { expect, test } from "vitest";
import { operatorAgent, SourceUnavailable, termsConsent } from "../src/compile-sources.ts";
import { testDb } from "./setup.ts";

const registry = "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e";

async function operator(cnfJwk: object): Promise<bigint> {
  const agentId = BigInt(`0x${randomBytes(6).toString("hex")}`);
  await testDb
    .insert(operators)
    .values({ agentId, chainId: 421614, agentRegistry: registry, name: "op", cnfJwk });
  return agentId;
}

test("the agent is the registered operator, its cnf key and its bond vault", async () => {
  const { publicKey } = await generateKeyPair("ES256");
  const { x, y } = await exportJWK(publicKey);
  const agentId = await operator({ kty: "EC", crv: "P-256", x, y });
  const agent = await operatorAgent(testDb, agentId)();
  expect(agent).toEqual({
    operator: { agent_registry: registry, agent_id: agentId.toString() },
    cnf: {
      jwk: {
        kty: "EC",
        crv: "P-256",
        x,
        y,
        kid: await calculateJwkThumbprint({
          kty: "EC",
          crv: "P-256",
          x: x as string,
          y: y as string,
        }),
      },
    },
    bond: {
      vault: `eip155:421614:${addresses[421614].KeelsonBondVault}`,
      asset: "PYUSD",
      min: 50_000_000,
    },
  });
  expect(MandateSchema.shape.agent.safeParse(agent).success).toBe(true);
});

test("an operator without a P-256 cnf key, or no operator, leaves the agent unavailable", async () => {
  const empty = await operator({});
  await expect(operatorAgent(testDb, empty)()).rejects.toBeInstanceOf(SourceUnavailable);
  await expect(operatorAgent(testDb, 1n << 60n)()).rejects.toThrow("agent is not available");
});

test("consent records the hash of the terms the app shows", async () => {
  const consent = await termsConsent();
  expect(consent.terms_hash).toBe(TERMS_HASH);
  expect(MandateSchema.shape.consent.safeParse(consent).success).toBe(true);
});
