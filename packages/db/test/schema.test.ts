import { randomBytes } from "node:crypto";
import { assert, expect, test } from "vitest";
import {
  alibis,
  attacks,
  disputes,
  events,
  mandates,
  operators,
  passkey,
  purchases,
  user,
  verdicts,
} from "../src/index.ts";
import { testDb } from "./setup.ts";

const { db } = testDb;
const ulid = (): string =>
  Array.from(randomBytes(26), (b) => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[b % 32]).join("");
const hash = (): Buffer => randomBytes(32);
const AGENT_ID = 2n ** 256n - 1n;

async function sqlState(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    let err: unknown = e;
    while (err && typeof err === "object") {
      if ("code" in err && typeof err.code === "string") return err.code;
      err = "cause" in err ? err.cause : undefined;
    }
  }
  return undefined;
}

async function newMandate(overrides: Partial<typeof mandates.$inferInsert> = {}) {
  const [operator] = await db
    .insert(operators)
    .values({
      agentId: AGENT_ID - BigInt(Math.floor(Math.random() * 1e9)),
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
      ...overrides,
    })
    .returning();
  assert(mandate);
  return mandate;
}

const purchaseValues = (mandateId: string): typeof purchases.$inferInsert => ({
  id: ulid(),
  mandateId,
  merchantId: "m1",
  currency: "USD",
  amountMinor: 1_500n,
  cartHash: hash(),
});

test("inserts one valid row per table", async () => {
  const mandate = await newMandate({ mandateHash: hash(), commitment: hash() });
  expect(mandate.state).toBe("DRAFT");
  const [operator] = await db.select().from(operators).limit(1);
  assert(operator);
  expect(typeof operator.agentId).toBe("bigint");

  const [purchase] = await db.insert(purchases).values(purchaseValues(mandate.id)).returning();
  assert(purchase);
  expect(purchase.state).toBe("PROPOSED");

  await db.insert(alibis).values({ purchaseId: purchase.id, leafHash: hash(), bundle: { v: 1 } });
  const [dispute] = await db
    .insert(disputes)
    .values({ id: "PP-D-1", purchaseId: purchase.id, reason: "item_not_received", raw: {} })
    .returning();
  assert(dispute);
  expect(dispute.state).toBe("OPEN");
  await db.insert(verdicts).values({
    id: ulid(),
    disputeId: dispute.id,
    liable: 1,
    ruleId: 3,
    amountMinor: 1_500n,
    currency: "USD",
    payee: "0xabc",
    digest: hash(),
  });
  await db.insert(attacks).values({
    id: ulid(),
    campaign: "c1",
    backbone: "b1",
    payloadHash: hash(),
    outcome: "BLOCKED",
  });
  const [event] = await db
    .insert(events)
    .values({ channel: "purchase", subjectId: "x", payload: {} })
    .returning();
  assert(event);
  expect(typeof event.id).toBe("bigint");
});

test("a 31-byte hash violates the length check", async () => {
  const mandate = await newMandate();
  const code = await sqlState(
    db.insert(purchases).values({ ...purchaseValues(mandate.id), cartHash: randomBytes(31) }),
  );
  expect(code).toBe("23514");
});

test("a duplicate invoice id violates the unique constraint", async () => {
  const mandate = await newMandate();
  await db.insert(purchases).values({ ...purchaseValues(mandate.id), invoiceId: "inv-dup" });
  const code = await sqlState(
    db.insert(purchases).values({ ...purchaseValues(mandate.id), invoiceId: "inv-dup" }),
  );
  expect(code).toBe("23505");
});

test("remaining above max violates the mandate check", async () => {
  const code = await sqlState(newMandate({ remainingMinor: 10_001n }));
  expect(code).toBe("23514");
});

test("an unknown decision violates the purchase check", async () => {
  const mandate = await newMandate();
  const code = await sqlState(
    db.insert(purchases).values({ ...purchaseValues(mandate.id), decision: 3 }),
  );
  expect(code).toBe("23514");
});

test("a non-positive amount violates the purchase check", async () => {
  const mandate = await newMandate();
  const code = await sqlState(
    db.insert(purchases).values({ ...purchaseValues(mandate.id), amountMinor: 0n }),
  );
  expect(code).toBe("23514");
});

test("an out-of-range liable value violates the dispute check", async () => {
  const mandate = await newMandate();
  const values = purchaseValues(mandate.id);
  await db.insert(purchases).values(values);
  const code = await sqlState(
    db
      .insert(disputes)
      .values({ id: "PP-D-2", purchaseId: values.id, reason: "r", liable: 5, raw: {} }),
  );
  expect(code).toBe("23514");
});

async function newUser() {
  const id = ulid();
  const [row] = await db
    .insert(user)
    .values({ id, name: "u", email: `${id}@example.com` })
    .returning();
  assert(row);
  return row;
}

test("a user's role defaults to user and cannot be null", async () => {
  expect((await newUser()).role).toBe("user");
  const id = ulid();
  const code = await sqlState(
    db.insert(user).values({ id, name: "u", email: `${id}@example.com`, role: null as never }),
  );
  expect(code).toBe("23502");
});

test("a credential id can be registered only once", async () => {
  const passkeyValues = (userId: string) => ({
    id: ulid(),
    publicKey: "pk",
    userId,
    credentialID: "cred-dup",
    counter: 0,
    deviceType: "singleDevice",
    backedUp: false,
  });
  await db.insert(passkey).values(passkeyValues((await newUser()).id));
  const code = await sqlState(db.insert(passkey).values(passkeyValues((await newUser()).id)));
  expect(code).toBe("23505");
});
