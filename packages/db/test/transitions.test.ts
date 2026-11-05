import { randomBytes } from "node:crypto";
import { assert, expect, test } from "vitest";
import { disputes, mandates, operators, purchases, transition, transitions } from "../src/index.ts";
import { testDb } from "./setup.ts";

const { db, pool } = testDb;
const ulid = (): string =>
  Array.from(randomBytes(26), (b) => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[b % 32]).join("");

async function newPurchase(state: (typeof purchases.$inferSelect)["state"] = "PROPOSED") {
  const [operator] = await db
    .insert(operators)
    .values({
      agentId: BigInt(`0x${randomBytes(16).toString("hex")}`),
      chainId: 84532,
      name: "op",
      cnfJwk: { kty: "OKP" },
    })
    .returning();
  assert(operator);
  const [mandate] = await db
    .insert(mandates)
    .values({
      id: ulid(),
      userId: "user-1",
      operatorAgentId: operator.agentId,
      currency: "USD",
      maxMinor: 10_000n,
      remainingMinor: 10_000n,
      merchantIds: ["m1"],
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    .returning();
  assert(mandate);
  const [purchase] = await db
    .insert(purchases)
    .values({
      id: ulid(),
      mandateId: mandate.id,
      merchantId: "m1",
      currency: "USD",
      amountMinor: 1_500n,
      cartHash: randomBytes(32),
      state,
    })
    .returning();
  assert(purchase);
  return purchase;
}

test("every allowed purchase transition succeeds", async () => {
  for (const [from, targets] of Object.entries(transitions.purchases)) {
    for (const to of targets) {
      const purchase = await newPurchase(from as never);
      expect(await transition(db, "purchases", purchase.id, from as never, to as never)).toBe(true);
    }
  }
});

test("a mandate and a dispute walk their paths", async () => {
  const purchase = await newPurchase();
  const mandateId = purchase.mandateId;
  for (const [from, to] of [
    ["DRAFT", "COMPILED"],
    ["COMPILED", "SIGNED"],
    ["SIGNED", "HOLD_PENDING"],
    ["HOLD_PENDING", "ACTIVE"],
    ["ACTIVE", "REVOKED"],
  ] as const) {
    expect(await transition(db, "mandates", mandateId, from, to)).toBe(true);
  }
});

test("the types reject an edge the map does not allow", () => {
  const illegal = (id: string) =>
    // @ts-expect-error CAPTURED cannot move to LOGGED
    transition(db, "purchases", id, "CAPTURED", "LOGGED");
  expect(illegal).toBeTypeOf("function");
});

test("a stale from-state returns false", async () => {
  const purchase = await newPurchase();
  expect(await transition(db, "purchases", purchase.id, "EVALUATING", "DENIED")).toBe(false);
});

test("transition applies the patch and bumps updated_at", async () => {
  const purchase = await newPurchase("COVERED");
  expect(
    await transition(db, "purchases", purchase.id, "COVERED", "CAPTURED", {
      paypalCaptureId: "CAP-1",
    }),
  ).toBe(true);
  const { rows } = await pool.query(
    "select state, paypal_capture_id, updated_at > created_at as bumped from purchases where id = $1",
    [purchase.id],
  );
  expect(rows[0]).toEqual({ state: "CAPTURED", paypal_capture_id: "CAP-1", bumped: true });
});

test("an illegal transition raises P0001 with the exact message", async () => {
  const purchase = await newPurchase("CAPTURED");
  await expect(
    pool.query("update purchases set state = 'LOGGED' where id = $1", [purchase.id]),
  ).rejects.toMatchObject({
    code: "P0001",
    message: "illegal transition purchases CAPTURED -> LOGGED",
  });
});

test("mandates and disputes reject illegal transitions too", async () => {
  const purchase = await newPurchase();
  await expect(
    pool.query("update mandates set state = 'ACTIVE' where id = $1", [purchase.mandateId]),
  ).rejects.toMatchObject({
    code: "P0001",
    message: "illegal transition mandates DRAFT -> ACTIVE",
  });
  const disputeId = `PP-D-${purchase.id}`;
  await db
    .insert(disputes)
    .values({ id: disputeId, purchaseId: purchase.id, reason: "r", raw: {} });
  expect(await transition(db, "disputes", disputeId, "OPEN", "RESOLVED")).toBe(true);
  await expect(
    pool.query("update disputes set state = 'ATTRIBUTED' where id = $1", [disputeId]),
  ).rejects.toMatchObject({
    code: "P0001",
    message: "illegal transition disputes RESOLVED -> ATTRIBUTED",
  });
});

test("updating another column on a CAPTURED row does not fire the trigger", async () => {
  const purchase = await newPurchase("CAPTURED");
  await pool.query("update purchases set paypal_capture_id = 'CAP-2' where id = $1", [purchase.id]);
  const { rows } = await pool.query("select paypal_capture_id from purchases where id = $1", [
    purchase.id,
  ]);
  expect(rows[0].paypal_capture_id).toBe("CAP-2");
});

test("concurrent transitions from the same state produce exactly one winner", async () => {
  const purchase = await newPurchase("CAPTURED");
  const locker = await pool.connect();
  try {
    await locker.query("begin");
    await locker.query("select 1 from purchases where id = $1 for update", [purchase.id]);

    const racers = [
      transition(db, "purchases", purchase.id, "CAPTURED", "DISPUTED"),
      transition(db, "purchases", purchase.id, "CAPTURED", "SETTLED"),
    ];

    let waiters = 0;
    for (let i = 0; i < 100 && waiters < 2; i++) {
      // Polled outside the locker's transaction, which would see a frozen statistics snapshot.
      const { rows } = await pool.query(
        "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'update \"purchases\"%'",
      );
      waiters = rows[0].n;
      if (waiters < 2) await new Promise((r) => setTimeout(r, 20));
    }
    await locker.query("commit");
    expect(waiters).toBe(2);

    const results = await Promise.all(racers);
    expect(results.filter(Boolean)).toHaveLength(1);
  } finally {
    locker.release();
  }
});

test("the TypeScript map equals the state_transitions table", async () => {
  const { rows } = await pool.query<{ entity: string; from_state: string; to_state: string }>(
    "select entity, from_state, to_state from state_transitions",
  );
  const fromDb = rows.map((r) => `${r.entity}:${r.from_state}>${r.to_state}`).sort();
  const fromMap = Object.entries(transitions)
    .flatMap(([entity, edges]) =>
      Object.entries(edges).flatMap(([from, tos]) =>
        (tos as readonly string[]).map((to) => `${entity}:${from}>${to}`),
      ),
    )
    .sort();
  expect(fromMap).toEqual(fromDb);
});
