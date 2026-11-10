import { randomBytes } from "node:crypto";
import { mandates, operators, user } from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import { beforeAll, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { testDb, testKv } from "./setup.ts";
import { headerPrincipal } from "./tee-live.ts";

const app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  authenticate: headerPrincipal,
});
const client = (subject: string, ...scopes: string[]) => ({
  "x-test-principal": JSON.stringify({ kind: "client", subject, scopes }),
});
const agentId = 9_000_000_000n + BigInt(randomBytes(3).readUIntBE(0, 3));
const otherAgent = agentId + 1n;
const linked = `op-${randomBytes(6).toString("hex")}`;
const sub = `kls_usr_${randomBytes(8).toString("hex")}`;
const active = ulid();
const revoked = ulid();
const elsewhere = ulid();
const path = (id: bigint) => `/v1/operators/${id}/mandates`;

beforeAll(async () => {
  const cnfJwk = { kty: "EC", crv: "P-256", x: "x", y: "y" };
  const registry = "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e";
  await testDb.insert(operators).values([
    { agentId, chainId: 421614, agentRegistry: registry, name: "Linked", cnfJwk, clientId: linked },
    { agentId: otherAgent, chainId: 421614, agentRegistry: registry, name: "Other", cnfJwk },
  ]);
  await testDb.insert(user).values({ id: sub, name: "Tester", email: `${sub}@example.test` });
  const base = {
    userId: sub,
    currency: "USD",
    maxMinor: 15_000n,
    remainingMinor: 15_000n,
    merchantIds: ["mrc_runfast"],
    expiresAt: new Date(Date.now() + 86_400_000),
  };
  await testDb.insert(mandates).values([
    {
      ...base,
      id: active,
      operatorAgentId: agentId,
      state: "ACTIVE",
      openMandate: "open~active~",
      holdMode: "mandate",
      paypalAuthorizationId: `AUTH${randomBytes(6).toString("hex").toUpperCase()}`,
    },
    {
      ...base,
      id: revoked,
      operatorAgentId: agentId,
      state: "REVOKED",
      openMandate: "open~revoked~",
    },
    {
      ...base,
      id: elsewhere,
      operatorAgentId: otherAgent,
      state: "ACTIVE",
      openMandate: "open~elsewhere~",
    },
  ]);
});

test("reading an operator's mandates takes a client token with countersign:write", async () => {
  expect((await app.request(path(agentId))).status).toBe(401);
  const asUser = { "x-test-principal": JSON.stringify({ kind: "user", subject: sub }) };
  expect((await app.request(path(agentId), { headers: asUser })).status).toBe(403);
  const res = await app.request(path(agentId), { headers: client(linked, "evidence:write") });
  expect(res.status).toBe(403);
});

test("only the client that linked the operator reads its mandates", async () => {
  const stranger = await app.request(path(agentId), {
    headers: client("someone-else", "countersign:write"),
  });
  expect(stranger.status).toBe(404);
  const unlinked = await app.request(path(otherAgent), {
    headers: client(linked, "countersign:write"),
  });
  expect(unlinked.status).toBe(404);
});

test("the linked client gets the active mandates naming its agent, with their holds", async () => {
  const res = await app.request(path(agentId), { headers: client(linked, "countersign:write") });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { mandates: Record<string, unknown>[] };
  expect(body.mandates).toHaveLength(1);
  expect(body.mandates[0]).toMatchObject({
    id: active,
    state: "ACTIVE",
    currency: "USD",
    remainingMinor: 15_000,
    holdMode: "mandate",
    openMandate: "open~active~",
  });
  expect(body.mandates[0]?.authorizationId).toMatch(/^AUTH/);
});
