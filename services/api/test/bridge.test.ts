import { randomBytes } from "node:crypto";
import { ALIBI_MEDIA_TYPE_V2, bridgeBundle, decodeAny } from "@keelson/alibi";
import { alibis, eq, mandates, purchases } from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import { hexToBytes } from "viem";
import { beforeAll, describe, expect, test } from "vitest";
import { fixtures } from "../../../packages/alibi/test/fixtures.ts";
import { receiptFor, vector } from "../../../packages/alibi/test/v2.ts";
import { bridgeAlibi, unbridged } from "../src/alibi/bridge.ts";
import { createApp } from "../src/app.ts";
import type { TeeConfig } from "../src/tee/signers.ts";
import { channel3Mandate } from "./channel3.ts";
import { testDb, testKv } from "./setup.ts";
import { asUser, headerPrincipal } from "./tee-live.ts";

const f = fixtures[0];
// Any call to a leg throws: these purchases must be answered without one.
const deps = {
  db: testDb,
  log: pino({ level: "silent" }),
  tee: {} as TeeConfig,
  tlog: { url: "http://127.0.0.1:9", token: "unused" },
};

async function purchase(o: { statement?: boolean; bridged?: boolean; alibi?: boolean } = {}) {
  const b = f?.bundle as NonNullable<typeof f>["bundle"];
  const c = b.tee.countersign;
  const id = ulid();
  await testDb.insert(purchases).values({
    id,
    mandateId: await channel3Mandate(),
    clientId: "observer-agent",
    state: "LOGGED",
    merchantId: String(b.eval.context.merchant),
    currency: "USD",
    amountMinor: BigInt(c.amount),
    cartHash: Buffer.from(c.cartHash.slice(2), "hex"),
    logIndex: BigInt(`0x${randomBytes(6).toString("hex")}`),
    ...(o.statement ? { statement: randomBytes(64) } : {}),
  });
  if (o.alibi !== false) {
    await testDb.insert(alibis).values({
      purchaseId: id,
      leafHash: randomBytes(32),
      bundle: { ...b, alibi_id: id },
      ...(o.bridged ? { bridgeBundle: { type: "application/vnd.keelson.alibi.v2+json" } } : {}),
    });
  }
  return id;
}

describe.skipIf(!f)("bridging v1 Alibis", () => {
  let v1: string;
  let v2: string;
  let bridged: string;
  let unissued: string;
  beforeAll(async () => {
    v1 = await purchase();
    v2 = await purchase({ statement: true });
    bridged = await purchase({ bridged: true });
    unissued = await purchase({ alibi: false });
  });

  test("a v2 purchase is never bridged, and a bridged one is not bridged again", async () => {
    expect(await bridgeAlibi(deps, v2)).toBe("v2");
    expect(await bridgeAlibi(deps, bridged)).toBe("done");
    expect(await bridgeAlibi(deps, unissued)).toBe("unissued");
    const [row] = await testDb.select().from(alibis).where(eq(alibis.purchaseId, v2));
    expect(row?.bridgeBundle).toBeNull();
  });

  test("the backfill walks only the v1 Alibis not bridged yet, oldest first", async () => {
    const later = await purchase();
    const ids = await unbridged(testDb, 100_000);
    expect(ids).toContain(v1);
    expect(ids.indexOf(v1)).toBeLessThan(ids.indexOf(later));
    for (const id of [v2, bridged, unissued]) expect(ids).not.toContain(id);
  });
});

describe.skipIf(f?.mode !== "2of2")("serving a bridged Alibi", () => {
  const app = createApp({
    db: testDb,
    kv: testKv,
    log: pino({ level: "silent" }),
    authenticate: headerPrincipal,
  });
  test("version 2 is the bridge bundle, version 1 stays the v1 bundle", async () => {
    const b = f?.bundle as NonNullable<typeof f>["bundle"];
    const statement = hexToBytes(`0x${vector("bridge-2of2").statement_hex}`);
    const v2 = bridgeBundle(b, statement, [receiptFor(statement).receipt], b.tlog_proof);
    const id = await purchase();
    const pending = await purchase();
    await testDb.update(alibis).set({ bridgeBundle: v2 }).where(eq(alibis.purchaseId, id));
    const [p] = await testDb
      .select({ userId: mandates.userId })
      .from(purchases)
      .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
      .where(eq(purchases.id, id));
    const as = asUser(p?.userId as string);

    const res = await app.request(`/v1/alibis/${id}?version=2`, { headers: as });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(ALIBI_MEDIA_TYPE_V2);
    expect(decodeAny(new Uint8Array(await res.arrayBuffer()))).toEqual(v2);

    const v1 = await app.request(`/v1/alibis/${id}`, { headers: as });
    expect(v1.headers.get("content-type")).not.toBe(ALIBI_MEDIA_TYPE_V2);
    expect((await app.request(`/v1/alibis/${pending}?version=2`, { headers: as })).status).toBe(
      404,
    );
  });
});
