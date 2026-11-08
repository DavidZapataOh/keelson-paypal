import { pino } from "pino";
import { ulid } from "ulid";
import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { testDb, testKv } from "./setup.ts";
import { headerPrincipal } from "./tee-live.ts";

const app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  authenticate: headerPrincipal,
});
const as = (...scopes: string[]) => ({
  "x-test-principal": JSON.stringify({ kind: "client", subject: "operators-test", scopes }),
});
const body = {
  chainId: 421614,
  agentId: "351",
  name: "Test operator",
  cnfJwk: {
    kty: "EC",
    crv: "P-256",
    x: "MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4",
    y: "4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM",
  },
  deadline: Math.floor(Date.now() / 1000) + 600,
  signature: `0x${"11".repeat(65)}`,
};
const post = (headers: Record<string, string>, payload: unknown = body) =>
  app.request("/v1/operators", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": ulid(), ...headers },
    body: JSON.stringify(payload),
  });
const type = async (res: Response) => ((await res.json()) as { type: string }).type;

test("linking takes the operators:write scope", async () => {
  expect((await post({})).status).toBe(401);
  expect((await post(as("countersign:write"))).status).toBe(403);
});

test("a chain outside ERC-8004's deployments is invalid", async () => {
  const res = await post(as("operators:write"), { ...body, chainId: 84532 });
  expect(res.status).toBe(422);
});

test("chain routes answer 503 when the chain is not read", async () => {
  const res = await post(as("operators:write"));
  expect(res.status).toBe(503);
  expect(await type(res)).toBe("https://api.keelson.finance/problems/chain-unavailable");
  for (const path of [
    "/v1/operators/421614/351/registration.json",
    "/v1/operators/421614/351/bond",
  ]) {
    expect((await app.request(path)).status, path).toBe(503);
  }
});
