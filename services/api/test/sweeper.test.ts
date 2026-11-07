import { randomBytes } from "node:crypto";
import { eq, mandates, operators, purchases, user } from "@keelson/db";
import { ulid } from "ulid";
import { expect, test } from "vitest";
import { failStalePurchases } from "../src/sweeper.ts";
import { testDb } from "./setup.ts";

await testDb.insert(user).values({ id: "user-1", name: "Tester", email: "sweeper@example.test" });

async function purchase(state: "PROPOSED" | "EVALUATING", ageMs: number) {
  const [operator] = await testDb
    .insert(operators)
    .values({
      agentId: BigInt(`0x${randomBytes(12).toString("hex")}`),
      chainId: 421614,
      name: "op",
      cnfJwk: {},
    })
    .returning();
  const [mandate] = await testDb
    .insert(mandates)
    .values({
      id: ulid(),
      userId: "user-1",
      operatorAgentId: (operator as { agentId: bigint }).agentId,
      currency: "USD",
      maxMinor: 10_000n,
      remainingMinor: 10_000n,
      merchantIds: ["m"],
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    .returning();
  const id = ulid();
  await testDb.insert(purchases).values({
    id,
    mandateId: (mandate as { id: string }).id,
    merchantId: "m",
    currency: "USD",
    amountMinor: 100n,
    cartHash: randomBytes(32),
    state,
    updatedAt: new Date(Date.now() - ageMs),
  });
  return id;
}

test("an evaluation older than two minutes is failed as stale, a younger one is left", async () => {
  const old = await purchase("EVALUATING", 3 * 60_000);
  const young = await purchase("EVALUATING", 30_000);
  const proposed = await purchase("PROPOSED", 10 * 60_000);

  expect(await failStalePurchases(testDb)).toBe(1);

  const state = async (id: string) =>
    (await testDb.select().from(purchases).where(eq(purchases.id, id)))[0];
  expect(await state(old)).toMatchObject({ state: "FAILED", failureReason: "stale" });
  expect((await state(young))?.state).toBe("EVALUATING");
  expect((await state(proposed))?.state).toBe("PROPOSED");
  expect(await failStalePurchases(testDb)).toBe(0);
});
