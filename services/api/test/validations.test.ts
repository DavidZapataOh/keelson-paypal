import { randomBytes } from "node:crypto";
import { countersignDigest, keelsonDomain } from "@keelson/core/eip712";
import { purchases } from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import { type Hex, keccak256 } from "viem";
import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import type { CountersignJson } from "../src/tee/client.ts";
import { VERIFYING_CONTRACT } from "../src/tee/config.ts";
import { countersignMessage } from "../src/tee/coordinator.ts";
import { channel3Mandate } from "./channel3.ts";
import { testDb, testKv } from "./setup.ts";

const app = createApp({ db: testDb, kv: testKv, log: pino({ level: "silent" }) });
const word = () => `0x${randomBytes(32).toString("hex")}` as Hex;

async function countersigned(logIndex: bigint | null) {
  const now = Math.floor(Date.now() / 1000);
  const countersign: CountersignJson = {
    requestId: word(),
    mandateHash: word(),
    mandateCommitment: word(),
    cartHash: word(),
    agentId: "351",
    merchantId: word(),
    amount: "4999",
    currency: "840",
    category: "3",
    evidenceRoot: word(),
    evalHash: word(),
    policySetHash: word(),
    decision: "1",
    failedFieldsMask: "0",
    issuedAt: String(now),
    expiresAt: String(now + 600),
  };
  const digest = countersignDigest(
    countersignMessage(countersign),
    keelsonDomain(421614, VERIFYING_CONTRACT),
  );
  const id = ulid();
  await testDb.insert(purchases).values({
    id,
    mandateId: await channel3Mandate(),
    merchantId: "shopwss.com",
    currency: "USD",
    amountMinor: 4999n,
    cartHash: Buffer.from(countersign.cartHash.slice(2), "hex"),
    countersignDigest: Buffer.from(digest.slice(2), "hex"),
    countersign,
    logIndex,
  });
  return { id, digest, countersign };
}

test("a countersign's validation request carries the payload its digest hashes", async () => {
  const { id, digest, countersign } = await countersigned(7n);
  const res = await app.request(`/v1/validations/${digest}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  const body = (await res.json()) as { payload: Hex; countersign: unknown; alibi?: string };
  expect(body.payload).toMatch(/^0x1901[0-9a-f]{128}$/);
  expect(keccak256(body.payload)).toBe(digest);
  expect(body.countersign).toEqual(countersign);
  expect(body.alibi).toBe(`/v1/alibis/${id}`);
});

test("a countersign not yet logged has no alibi", async () => {
  const { digest } = await countersigned(null);
  const body = (await (await app.request(`/v1/validations/${digest}`)).json()) as object;
  expect(body).not.toHaveProperty("alibi");
});

test("an unknown request hash is not found", async () => {
  const res = await app.request(`/v1/validations/${word()}`);
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
});
