import { randomBytes } from "node:crypto";
import { chainTxs, eq, mandates } from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { rootKey } from "../src/zk/c3.ts";
import { channel3Mandate } from "./channel3.ts";
import { testDb, testKv } from "./setup.ts";
import { asUser, headerPrincipal } from "./tee-live.ts";

const app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  authenticate: headerPrincipal,
});

async function read(id: string, sub: string) {
  const res = await app.request(`/v1/mandates/${id}`, { headers: asUser(sub) });
  expect(res.status).toBe(200);
  return (await res.json()) as { c3Published: boolean };
}

test("a mandate's C3 is published once its proof is stored and its root is on chain", async () => {
  const id = await channel3Mandate();
  const [m] = await testDb
    .select({ userId: mandates.userId })
    .from(mandates)
    .where(eq(mandates.id, id));
  const sub = m?.userId as string;
  expect((await read(id, sub)).c3Published).toBe(false);

  const root = `0x${randomBytes(32).toString("hex")}`;
  await testDb
    .update(mandates)
    .set({ c3Proof: { proof: "", public_inputs: ["0x00", "0x00", root], recursive_proof: "" } })
    .where(eq(mandates.id, id));
  // Proved, but its root is not on chain yet.
  expect((await read(id, sub)).c3Published).toBe(false);

  await testDb.insert(chainTxs).values({
    id: ulid(),
    chainId: 421614,
    key: rootKey(root),
    contract: "RegisteredUserSet",
    function: "publish",
    sender: randomBytes(20),
    to: randomBytes(20),
    data: randomBytes(4),
    dataHash: randomBytes(32),
    hash: randomBytes(32),
    status: "confirmed",
  });
  expect((await read(id, sub)).c3Published).toBe(true);
});
