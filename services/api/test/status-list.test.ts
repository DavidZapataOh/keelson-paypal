import { eq, mandates, sql, statusLists } from "@keelson/db";
import { decodeStatusList, STATUS_SIZE, STATUS_URI } from "@keelson/mandate";
import { pino } from "pino";
import { beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import {
  currentStatusToken,
  drawStatusIdx,
  publishStatusList,
  type StatusListDeps,
} from "../src/status-list.ts";
import { channel3Mandate } from "./channel3.ts";
import { testDb, testKv } from "./setup.ts";

const log = pino({ level: "silent" });
const signed: { uri: string; lst: string }[] = [];
// Leg A's answer is the list it was asked to sign; the engine's own tests cover its signature.
const tee = {
  client: {
    a: {
      signStatus: async (req: { uri: string; lst: string }) => {
        signed.push(req);
        return { token: `token-${signed.length}` };
      },
    },
  },
} as unknown as StatusListDeps["tee"];
const deps: StatusListDeps = { db: testDb, log, tee };
const bit = (bits: Uint8Array, i: number) => ((bits[i >> 3] ?? 0) >> (i & 7)) & 1;

async function listed(revoked: boolean): Promise<number> {
  const id = await channel3Mandate();
  const idx = await drawStatusIdx(testDb);
  await testDb
    .update(mandates)
    .set({ statusIdx: idx, ...(revoked ? { revokeRequestedAt: sql`now()` } : {}) })
    .where(eq(mandates.id, id));
  return idx;
}

describe("the mandate status list", () => {
  let live: number;
  let gone: number;
  beforeAll(async () => {
    live = await listed(false);
    gone = await listed(true);
  });

  test("indexes are drawn inside the list and never twice", async () => {
    expect(live).not.toBe(gone);
    for (const i of [live, gone]) expect(i >= 0 && i < STATUS_SIZE).toBe(true);
  });

  test("leg A is asked to sign the bit of every revoked mandate, and the token is stored", async () => {
    const token = await publishStatusList(deps);
    const last = signed.at(-1);
    expect(last?.uri).toBe(STATUS_URI);
    const bits = await decodeStatusList(last?.lst as string);
    expect(bit(bits, gone)).toBe(1);
    expect(bit(bits, live)).toBe(0);
    const [row] = await testDb.select().from(statusLists).where(eq(statusLists.uri, STATUS_URI));
    expect(row?.token).toBe(token);
  });

  test("a countersign reuses a fresh token and has an old one signed again", async () => {
    const before = signed.length;
    const fresh = await currentStatusToken(deps);
    expect(signed.length).toBe(before);
    await testDb
      .update(statusLists)
      .set({ signedAt: new Date(Date.now() - 241_000) })
      .where(eq(statusLists.uri, STATUS_URI));
    const again = await currentStatusToken(deps);
    expect(signed.length).toBe(before + 1);
    expect(again).not.toBe(fresh);
  });

  test("the published token is served as application/statuslist+jwt", async () => {
    const app = createApp({ db: testDb, kv: testKv, log });
    const res = await app.request("/status/v1/mandates/2026-1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/statuslist+jwt");
    expect(await res.text()).toMatch(/^token-\d+$/);
  });
});
