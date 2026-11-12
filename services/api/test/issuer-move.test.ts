import { randomBytes } from "node:crypto";
import { mandates, operators, teeSigners, user } from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import { beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { createTee } from "../src/tee/config.ts";
import { testDb, testKv } from "./setup.ts";
import { asUser, carts, headerPrincipal } from "./tee-live.ts";

const { cart, unit } = carts.demo;

const OLD = `0x${"7d".repeat(32)}`;
const NEW = `0x${"a1".repeat(32)}`;
const CLIENT = "issuer-move-test";

// Unreachable legs: a countersign that reached them would answer 503, not the renewal problem.
const tee = createTee(
  {
    TEE_A_URL: "http://127.0.0.1:9",
    TEE_B_URL: "http://127.0.0.1:9",
    KEELSON_TEE_TOKEN: "unused",
    ARBITRUM_SEPOLIA_RPC_URL: "http://127.0.0.1:9",
  },
  { a: 500, b: 500 },
);
const app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  authenticate: headerPrincipal,
  tee,
});

async function mandateUnder(issuer: string) {
  const userId = `user-${ulid()}`;
  await testDb.insert(user).values({ id: userId, name: "Tester", email: `${userId}@example.test` });
  const agentId = BigInt(`0x${randomBytes(12).toString("hex")}`);
  await testDb.insert(operators).values({
    agentId,
    chainId: 421614,
    agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    name: "op",
    cnfJwk: {},
    clientId: CLIENT,
  });
  const id = ulid();
  await testDb.insert(mandates).values({
    id,
    userId,
    operatorAgentId: agentId,
    state: "ACTIVE",
    currency: "USD",
    maxMinor: 10_000n,
    remainingMinor: 10_000n,
    merchantIds: [cart.merchant],
    expiresAt: new Date(Date.now() + 86_400_000),
    openMandate: "open",
    mandateHash: randomBytes(32),
    holdMode: "mandate",
    paypalAuthorizationId: `AUTH${randomBytes(6).toString("hex").toUpperCase()}`,
    issuerThumbprint: issuer,
  });
  return { id, userId };
}

describe("the issuer move", () => {
  beforeAll(async () => {
    // Leg A now attests the new issuer.
    await testDb.delete(teeSigners);
    await testDb.insert(teeSigners).values({
      address: randomBytes(20),
      teeKind: 1,
      measurement: `tdx:${"00".repeat(32)}`,
      binding: { issuerJwkThumbprint: NEW },
      attestation: {},
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  });

  test("a mandate issued with the previous issuer needs renewal and is never sent to a leg", async () => {
    const m = await mandateUnder(OLD);
    const res = await app.request("/v1/countersign", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": ulid(),
        "x-test-principal": JSON.stringify({
          kind: "client",
          subject: CLIENT,
          scopes: ["countersign:write"],
        }),
      },
      body: JSON.stringify({
        authorizationId: "AUTH",
        closedMandate: closed(m.id, ulid()),
        cart,
        unit,
        evidenceRoot: `0x${"00".repeat(32)}`,
      }),
    });
    const body = (await res.json()) as { type?: string };
    expect(res.status).toBe(409);
    expect(body.type).toMatch(/\/mandate-needs-renewal$/);

    const view = await app.request(`/v1/mandates/${m.id}`, { headers: asUser(m.userId) });
    expect(((await view.json()) as { needsRenewal?: boolean }).needsRenewal).toBe(true);
  });

  test("a mandate issued with the current issuer does not", async () => {
    const m = await mandateUnder(NEW);
    const view = await app.request(`/v1/mandates/${m.id}`, { headers: asUser(m.userId) });
    expect(((await view.json()) as { needsRenewal?: boolean }).needsRenewal).toBe(false);
  });
});

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const closed = (mid: string, requestId: string) =>
  [
    "e30.e30.sig",
    b64(["salt", "mandate", { v: "keelson.mandate.1", mid }]),
    `e30.${b64({ nonce: requestId })}.sig`,
  ].join("~");
