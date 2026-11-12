import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALIBI_MEDIA_TYPE_V2,
  decodeAny,
  encodeAny,
  fromBase64,
  leafHashOf,
  registeredOf,
  STATEMENT_MEDIA_TYPE,
  statementOf,
} from "@keelson/alibi";
import { alibis, eq, mandates, purchases, timestamps } from "@keelson/db";
import { decodeSign1, statementImprint, TST_CTT } from "@keelson/scitt";
import { pino } from "pino";
import { ulid } from "ulid";
import { beforeAll, describe, expect, test } from "vitest";
import { fixtures } from "../../../packages/alibi/test/fixtures.ts";
import { v2Bundle } from "../../../packages/alibi/test/v2.ts";
import { loadAlibi } from "../src/alibi/issue.ts";
import { createApp } from "../src/app.ts";
import { channel3Mandate } from "./channel3.ts";
import { testDb, testKv } from "./setup.ts";
import { asUser, headerPrincipal } from "./tee-live.ts";

const app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  authenticate: headerPrincipal,
});
const cddl = new URL("../../../internal/scitt/cddl/validate.sh", import.meta.url).pathname;
const hasCddl = () => {
  try {
    execFileSync(process.env.CDDL_BIN ?? "cddl", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe("v2 Alibis", () => {
  const core = v2Bundle();
  // Another purchase id, so the shared database's v1 fixtures are left alone.
  const id = ulid();
  const bundle = { ...core, alibi_id: id };
  let as: Record<string, string>;
  beforeAll(async () => {
    const mandateId = await channel3Mandate();
    const [m] = await testDb.select().from(mandates).where(eq(mandates.id, mandateId));
    as = asUser(m?.userId as string);
    await testDb.insert(purchases).values({
      id,
      mandateId,
      clientId: "observer-agent",
      state: "LOGGED",
      merchantId: "store",
      currency: "USD",
      amountMinor: 100n,
      cartHash: Buffer.alloc(32, 1),
      statement: Buffer.from(registeredOf(core)),
    });
    await testDb.insert(alibis).values({
      purchaseId: id,
      leafHash: Buffer.from(leafHashOf(core)),
      bundle,
    });
  });

  test("the bundle route serves the v2 bundle with its media type", async () => {
    const res = await app.request(`/v1/alibis/${id}`, { headers: as });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(ALIBI_MEDIA_TYPE_V2);
    expect(decodeAny(new Uint8Array(await res.arrayBuffer()))).toEqual(bundle);
  });

  test("the .cose route serves the statement the log registered, to anyone", async () => {
    const res = await app.request(`/v1/alibis/${id}.cose`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(STATEMENT_MEDIA_TYPE);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(statementOf(bundle));
    const [row] = await testDb.select().from(alibis).where(eq(alibis.purchaseId, id));
    expect(
      Buffer.from(leafHashOf({ ...bundle, statement: Buffer.from(bytes).toString("base64") })),
    ).toEqual(row?.leafHash);
    const v1 = fixtures[0];
    if (v1) expect((await app.request(`/v1/alibis/${ulid()}.cose`)).status).toBe(404);
  });

  test("a statement token lands in label 270; the leaf and every section stay the same", async () => {
    const before = await loadAlibi(testDb, id);
    const token = fromBase64(fixtures[0]?.bundle.timestamps[0]?.token as string);
    const sig = decodeSign1(statementOf(bundle)).signature;
    await testDb.insert(timestamps).values({
      hash: Buffer.from(statementImprint(sig)),
      kind: "statement",
      tsa: "digicert",
      role: "primary",
      status: "stamped",
      token: Buffer.from(token),
    });
    const after = await loadAlibi(testDb, id);
    if (!before || !after || after.type !== ALIBI_MEDIA_TYPE_V2) throw new Error("no v2 Alibi");
    const s = decodeSign1(statementOf(after));
    expect(s.unprotected.get(TST_CTT)).toEqual(token);
    expect(after.statement).not.toBe((before as typeof after).statement);
    expect(leafHashOf(after)).toEqual(leafHashOf(before));
    const { statement: _a, ...rest } = after;
    const { statement: _b, ...restBefore } = before as typeof after;
    expect(rest).toEqual(restBefore);
    const res = await app.request(`/v1/alibis/${id}.cose`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(statementOf(after));
  });

  test("POST /verify reads a v2 bundle and a bare statement, and answers EAR on request", async () => {
    // The golden statement's own Alibi id.
    const body = encodeAny(core);
    const json = await app.request("/v1/alibis/verify", {
      method: "POST",
      headers: { "content-type": ALIBI_MEDIA_TYPE_V2, "idempotency-key": ulid() },
      body: body as Uint8Array<ArrayBuffer>,
    });
    expect(json.status).toBe(200);
    const report = (await json.json()) as { checks: { id: string; status: string }[] };
    expect(report.checks.find((c) => c.id === "scitt.statement")?.status).toBe("pass");

    const cose = await app.request("/v1/alibis/verify", {
      method: "POST",
      headers: { "content-type": STATEMENT_MEDIA_TYPE, "idempotency-key": ulid() },
      body: statementOf(bundle) as Uint8Array<ArrayBuffer>,
    });
    expect(cose.status).toBe(200);

    const ear = await app.request("/v1/alibis/verify", {
      method: "POST",
      headers: {
        "content-type": ALIBI_MEDIA_TYPE_V2,
        accept: "application/eat-ucs+json",
        "idempotency-key": ulid(),
      },
      body: body as Uint8Array<ArrayBuffer>,
    });
    expect(ear.headers.get("content-type")).toBe("application/eat-ucs+json");
    const claims = (await ear.json()) as Record<string, unknown>;
    expect(claims.eat_profile).toBe("tag:ietf.org,2026:rats/ear#05");
    expect(Object.keys(claims.submods as object).sort()).toEqual(expect.arrayContaining(["tdx"]));
    if (hasCddl()) {
      const file = join(mkdtempSync(join(tmpdir(), "ear-")), "ear.json");
      writeFileSync(file, JSON.stringify(claims));
      execFileSync(cddl, ["ear-05.cddl", "EAR", file]);
    }
  });
});
