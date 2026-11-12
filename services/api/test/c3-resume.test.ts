import { randomBytes } from "node:crypto";
import { eq, purchases, sql } from "@keelson/db";
import { ulid } from "ulid";
import { expect, test } from "vitest";
import { resumeAwaitingC3 } from "../src/pipeline/drive.ts";
import { channel3Mandate } from "./channel3.ts";
import { testDb } from "./setup.ts";

async function purchase(mandateId: string, state: string, leaseUntil: Date | null) {
  const id = ulid();
  await testDb.insert(purchases).values({
    id,
    mandateId,
    clientId: "observer-agent",
    state,
    merchantId: "mrc_alfred",
    currency: "USD",
    amountMinor: 100n,
    cartHash: randomBytes(32),
    countersign: { issuedAt: String(Math.floor(Date.now() / 1000)) },
    leaseUntil,
  } as typeof purchases.$inferInsert);
  return id;
}

const row = async (id: string) =>
  (
    await testDb
      .select({
        leaseUntil: purchases.leaseUntil,
        updatedAt: purchases.updatedAt,
        due: sql<boolean>`${purchases.leaseUntil} < now()`,
      })
      .from(purchases)
      .where(eq(purchases.id, id))
  )[0];

test("once its mandate's C3 is published, a purchase waiting for its Alibi is due at once", async () => {
  const mandateId = await channel3Mandate();
  const waiting = await purchase(mandateId, "COVERED", null);
  const before = await row(waiting);

  expect(await resumeAwaitingC3(testDb, mandateId)).toBe(1);

  const after = await row(waiting);
  // The resumer drives a purchase whose lease has run out, on its next pass.
  expect(after?.due).toBe(true);
  expect(after?.updatedAt).toEqual(before?.updatedAt);
});

test("a purchase another driver holds, and one that has ended, are left as they are", async () => {
  const mandateId = await channel3Mandate();
  const lease = new Date(Date.now() + 20_000);
  const driving = await purchase(mandateId, "LOGGED", lease);
  const ended = await purchase(mandateId, "CAPTURED", null);
  const elsewhere = await purchase(await channel3Mandate(), "COVERED", null);

  expect(await resumeAwaitingC3(testDb, mandateId)).toBe(0);

  expect((await row(driving))?.leaseUntil).toEqual(lease);
  expect((await row(ended))?.leaseUntil).toBeNull();
  expect((await row(elsewhere))?.leaseUntil).toBeNull();
});
