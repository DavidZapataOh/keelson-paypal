import { randomBytes } from "node:crypto";
import { beforeEach, expect, test } from "vitest";
import { disputes, events, mandates, operators, purchases } from "../src/index.ts";
import { createQueries } from "../src/queries.ts";
import { testDb } from "./setup.ts";

const { db, pool } = testDb;
const q = createQueries(db);
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = (): string => Array.from(randomBytes(26), (b) => ALPHABET[b % 32]).join("");
const hash = (): Buffer => randomBytes(32);

const agentId = 7n;
const base = Date.now() - 3_600_000;
const at = (i: number): Date => new Date(base + i * 1000);

let mandateIds: string[];
let purchaseIds: string[];

beforeEach(async () => {
  await pool.query(
    "truncate events, disputes, purchases, mandates, operators restart identity cascade",
  );
  await db.insert(operators).values({
    agentId,
    chainId: 421614,
    agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    name: "op",
    cnfJwk: { kty: "OKP" },
  });
  mandateIds = Array.from({ length: 5 }, ulid);
  await db.insert(mandates).values(
    mandateIds.map((id, i) => ({
      id,
      userId: "user-1",
      operatorAgentId: agentId,
      currency: "USD",
      maxMinor: 10_000n,
      remainingMinor: 10_000n,
      merchantIds: ["m1"],
      expiresAt: at(10_000),
      createdAt: at(i < 3 ? 0 : i),
    })),
  );
  purchaseIds = Array.from({ length: 5 }, ulid);
  await db.insert(purchases).values(
    purchaseIds.map((id, i) => ({
      id,
      mandateId: mandateIds[0] as string,
      merchantId: "m1",
      currency: "USD",
      amountMinor: 100n,
      cartHash: hash(),
      state: (i < 2 ? "PROPOSED" : i < 4 ? "CAPTURED" : "SETTLED") as "PROPOSED",
      invoiceId: `inv-${i}`,
      paypalCaptureId: `cap-${i}`,
      createdAt: at(i < 3 ? 0 : i),
    })),
  );
});

async function pages<T extends { id: string }>(
  fetch: (limit: number, before?: string) => Promise<T[]>,
  limit: number,
): Promise<string[][]> {
  const out: string[][] = [];
  let before: string | undefined;
  for (;;) {
    const rows = await fetch(limit, before);
    if (rows.length === 0) return out;
    out.push(rows.map((r) => r.id));
    before = rows.at(-1)?.id;
    if (rows.length < limit) return out;
  }
}

test("mandateById returns the row or undefined", async () => {
  const id = mandateIds[0] as string;
  expect((await q.mandateById(id))?.id).toBe(id);
  expect(await q.mandateById(ulid())).toBeUndefined();
});

test("mandatesByUser pages by (created_at desc, id desc) without gaps or overlap", async () => {
  const result = await pages((l, b) => q.mandatesByUser("user-1", l, b), 2);
  const flat = result.flat();
  expect(result.map((p) => p.length)).toEqual([2, 2, 1]);
  expect(new Set(flat).size).toBe(5);
  expect([...flat].sort()).toEqual([...mandateIds].sort());
  const ties = flat.slice(2).filter((id) => mandateIds.indexOf(id) < 3);
  expect(ties).toEqual([...ties].sort().reverse());
  expect(await q.mandatesByUser("nobody", 10)).toEqual([]);
});

test("purchaseById, purchaseByInvoiceId and purchaseByCaptureId find the same row", async () => {
  const id = purchaseIds[2] as string;
  expect((await q.purchaseById(id))?.id).toBe(id);
  expect((await q.purchaseByInvoiceId("inv-2"))?.id).toBe(id);
  expect((await q.purchaseByCaptureId("cap-2"))?.id).toBe(id);
  expect(await q.purchaseByInvoiceId("missing")).toBeUndefined();
  expect(await q.purchaseByCaptureId("missing")).toBeUndefined();
});

test("purchasesByMandate pages by (created_at desc, id desc) without gaps or overlap", async () => {
  const mandateId = mandateIds[0] as string;
  const result = await pages((l, b) => q.purchasesByMandate(mandateId, l, b), 2);
  const flat = result.flat();
  expect(result.map((p) => p.length)).toEqual([2, 2, 1]);
  expect([...flat].sort()).toEqual([...purchaseIds].sort());
  expect(await q.purchasesByMandate(mandateIds[1] as string, 10)).toEqual([]);
});

test("openPurchases returns only non-terminal purchases, oldest first", async () => {
  const rows = await q.openPurchases(10);
  expect(rows.map((r) => r.state).sort()).toEqual(["CAPTURED", "CAPTURED", "PROPOSED", "PROPOSED"]);
  expect(rows.every((r) => r.id !== purchaseIds[4])).toBe(true);
  expect(rows.map((r) => r.createdAt.getTime())).toEqual(
    rows.map((r) => r.createdAt.getTime()).sort((a, b) => a - b),
  );
  expect(await q.openPurchases(1)).toHaveLength(1);
});

test("disputeById returns the row or undefined", async () => {
  await db.insert(disputes).values({
    id: "PP-D-1",
    purchaseId: purchaseIds[0] as string,
    reason: "item_not_received",
    raw: { id: "PP-D-1" },
  });
  expect((await q.disputeById("PP-D-1"))?.purchaseId).toBe(purchaseIds[0]);
  expect(await q.disputeById("PP-D-2")).toBeUndefined();
});

test("eventsAfter returns the channel's events after the cursor in id order", async () => {
  await db.insert(events).values([
    ...Array.from({ length: 5 }, (_, i) => ({
      channel: "a",
      subjectId: `s${i}`,
      payload: { i },
    })),
    { channel: "b", subjectId: "x", payload: {} },
  ]);
  const all = await q.eventsAfter("a", 0n, 10);
  expect(all).toHaveLength(5);
  expect(all.map((e) => e.id)).toEqual([...all.map((e) => e.id)].sort((x, y) => Number(x - y)));
  const next = await q.eventsAfter("a", all[1]?.id as bigint, 2);
  expect(next.map((e) => e.id)).toEqual([all[2]?.id, all[3]?.id]);
  expect(await q.eventsAfter("c", 0n, 10)).toEqual([]);
});
