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
  purchaseHolds,
  purchases,
  teeSigners,
  user,
  verdicts,
} from "../src/index.ts";
import { testDb } from "./setup.ts";

const { db, pool } = testDb;
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
      chainId: 421614,
      agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
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

test("a mandate must belong to an existing user", async () => {
  expect(await sqlState(newMandate({ userId: ulid() }))).toBe("23503");
});

test("a passkey counter holds any WebAuthn signCount (uint32)", async () => {
  const [row] = await db
    .insert(passkey)
    .values({
      id: ulid(),
      publicKey: "pk",
      userId: (await newUser()).id,
      credentialID: ulid(),
      counter: 2 ** 32 - 1,
      deviceType: "singleDevice",
      backedUp: false,
    })
    .returning();
  expect(row?.counter).toBe(2 ** 32 - 1);
});

const signer = (teeKind: number, revokedAt: Date | null = null) => ({
  address: randomBytes(20),
  teeKind,
  measurement: "tdx:00",
  binding: {},
  attestation: {},
  expiresAt: new Date(Date.now() + 3_600_000),
  revokedAt,
});

test("a TEE kind has at most one active signer", async () => {
  await db.insert(teeSigners).values(signer(1));
  expect(await sqlState(db.insert(teeSigners).values(signer(1)))).toBe("23505");
  await db.insert(teeSigners).values(signer(2));
  await db.insert(teeSigners).values(signer(1, new Date()));
  await db.insert(teeSigners).values(signer(1, new Date()));
});

test("a purchase records only a known countersign mode", async () => {
  const purchase = await db.query.purchases.findFirst();
  const row = async (mode: string) =>
    sqlState(
      pool.query(
        "update purchases set countersign_mode = $1 where id = (select id from purchases limit 1)",
        [mode],
      ),
    );
  expect(purchase === undefined || purchase.countersignMode === null).toBe(true);
  expect(await row("2of2")).toBeUndefined();
  expect(await row("degraded")).toBeUndefined();
  expect(await row("solo")).toBe("23514");
});

test("an unknown hold mode violates the mandate check", async () => {
  expect(await sqlState(newMandate({ holdMode: "other" as never }))).toBe("23514");
});

test("two mandates cannot share a parent authorization", async () => {
  await newMandate({ paypalParentAuthorizationId: "AUTH-PARENT-1" });
  const code = await sqlState(newMandate({ paypalParentAuthorizationId: "AUTH-PARENT-1" }));
  expect(code).toBe("23505");
});

const holdValues = (mandateId: string): typeof purchaseHolds.$inferInsert => ({
  requestId: ulid(),
  mandateId,
  merchantId: "m1",
  currency: "USD",
  amountMinor: 4_250n,
  cartHash: hash(),
  paypalOrderId: `ORDER-${ulid()}`,
  state: "PENDING",
});

test("a purchase hold starts PENDING under its mandate", async () => {
  const mandate = await newMandate({ holdMode: "per_purchase" });
  expect(mandate.holdMode).toBe("per_purchase");
  const [hold] = await db.insert(purchaseHolds).values(holdValues(mandate.id)).returning();
  assert(hold);
  expect(hold.state).toBe("PENDING");
  expect(hold.paypalAuthorizationId).toBeNull();
});

test("a non-positive purchase hold violates its check", async () => {
  const mandate = await newMandate({ holdMode: "per_purchase" });
  const code = await sqlState(
    db.insert(purchaseHolds).values({ ...holdValues(mandate.id), amountMinor: 0n }),
  );
  expect(code).toBe("23514");
});

test("an unknown purchase hold state violates its check", async () => {
  const mandate = await newMandate({ holdMode: "per_purchase" });
  const code = await sqlState(
    db.insert(purchaseHolds).values({ ...holdValues(mandate.id), state: "OTHER" as never }),
  );
  expect(code).toBe("23514");
});

test("two purchase holds cannot share an order", async () => {
  const mandate = await newMandate({ holdMode: "per_purchase" });
  const first = holdValues(mandate.id);
  await db.insert(purchaseHolds).values(first);
  const code = await sqlState(
    db
      .insert(purchaseHolds)
      .values({ ...holdValues(mandate.id), paypalOrderId: first.paypalOrderId }),
  );
  expect(code).toBe("23505");
});
