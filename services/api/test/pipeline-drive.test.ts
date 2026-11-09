import { randomBytes } from "node:crypto";
import { eq, purchases, sql } from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import { expect, test } from "vitest";
import { drivePurchase } from "../src/pipeline/drive.ts";
import { channel3Mandate } from "./channel3.ts";
import { testDb, testKv } from "./setup.ts";

test("a purchase left COUNTERSIGNED without its stored countersign is failed, not retried forever", async () => {
  const mandateId = await channel3Mandate();
  const id = ulid();
  await testDb.insert(purchases).values({
    id,
    mandateId,
    state: "COUNTERSIGNED",
    merchantId: "mrc_runfast",
    currency: "USD",
    amountMinor: 100n,
    cartHash: randomBytes(32),
    updatedAt: sql`now() - interval '1 minute'`,
  });
  await drivePurchase({ db: testDb, kv: testKv, log: pino({ level: "silent" }) }, id);
  const [p] = await testDb.select().from(purchases).where(eq(purchases.id, id));
  expect(p?.state).toBe("FAILED");
  expect(p?.failureReason).toBe("pipeline:no-countersign");
  expect(p?.leaseUntil).toBeNull();
});
