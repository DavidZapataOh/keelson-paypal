import { randomBytes } from "node:crypto";
import { decodeAlibi, decodeReceipt, leafHashOf } from "@keelson/alibi";
import { extractAlibi } from "@keelson/alibi/extract";
import {
  alibis,
  evidenceBundles,
  mandates,
  operators,
  purchases,
  timestamps,
  user,
} from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { fixtures } from "../../../packages/alibi/test/fixtures.ts";
import { createApp } from "../src/app.ts";
import { testDb, testKv } from "./setup.ts";
import { asUser, headerPrincipal } from "./tee-live.ts";

const app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  authenticate: headerPrincipal,
});
const asClient = (subject: string, scopes = ["alibis:read"]) => ({
  "x-test-principal": JSON.stringify({ kind: "client", subject, scopes }),
});
const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });

const f = fixtures[0];
const owner = `user-${randomBytes(6).toString("hex")}`;
const uploader = "operator-client";

describe.skipIf(!f)("alibi routes", () => {
  beforeAll(async () => {
    const b = f?.bundle as NonNullable<typeof f>["bundle"];
    const c = b.tee.countersign;
    await testDb.insert(user).values({ id: owner, name: "Tester", email: `${owner}@example.test` });
    await testDb.insert(user).values({ id: "other", name: "Other", email: "other@example.test" });
    const [operator] = await testDb
      .insert(operators)
      .values({
        agentId: BigInt(c.agentId),
        chainId: 421614,
        agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
        name: "op",
        cnfJwk: {},
      })
      .onConflictDoNothing()
      .returning();
    const mandateId = ulid();
    await testDb.insert(mandates).values({
      id: mandateId,
      userId: owner,
      operatorAgentId: operator?.agentId ?? BigInt(c.agentId),
      state: "ACTIVE",
      currency: "USD",
      maxMinor: 10_000n,
      remainingMinor: 10_000n,
      merchantIds: ["store"],
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const root = Buffer.from(c.evidenceRoot.slice(2), "hex");
    await testDb.insert(evidenceBundles).values({
      root,
      mandateId,
      manifest: b.manifest.public,
      uploadedBy: uploader,
    });
    await testDb.insert(purchases).values({
      id: b.alibi_id,
      mandateId,
      clientId: uploader,
      state: "CAPTURED",
      merchantId: String(b.eval.context.merchant),
      currency: "USD",
      amountMinor: BigInt(c.amount),
      cartHash: Buffer.from(c.cartHash.slice(2), "hex"),
      invoiceId: b.paypal?.invoice_id ?? null,
      paypalCaptureId: b.paypal?.capture_id ?? null,
    });
    const hash = Buffer.from(leafHashOf(b));
    for (const t of b.timestamps) {
      await testDb.insert(timestamps).values({
        hash,
        kind: "leaf",
        tsa: t.tsa,
        role: "primary",
        status: "stamped",
        token: Buffer.from(t.token, "base64"),
      });
    }
    const { timestamps: _t, anchor: _a, ...core } = b;
    await testDb.insert(alibis).values({
      purchaseId: b.alibi_id,
      leafHash: Buffer.from(leafHashOf(b)),
      bundle: {
        ...core,
        timestamps: [],
        paypal: { ...core.paypal, capture_id: undefined, invoice_id: undefined },
      },
      ...(b.anchor ? { anchor: b.anchor } : {}),
    });
  });

  afterAll(async () => {
    await testDb.delete(alibis);
  });

  test("the mandate's user reads the bundle, with an ETag", async () => {
    const res = await get(`/v1/alibis/${f?.id}`, asUser(owner));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.keelson.alibi.v1+json");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(decodeAlibi(bytes).alibi_id).toBe(f?.id);
    expect(bytes).toEqual(f?.bytes);
    const etag = res.headers.get("etag") as string;
    const again = await get(`/v1/alibis/${f?.id}`, { ...asUser(owner), "if-none-match": etag });
    expect(again.status).toBe(304);
  });

  test("the uploading client reads it; other principals get 404", async () => {
    expect((await get(`/v1/alibis/${f?.id}`, asClient(uploader))).status).toBe(200);
    for (const h of [
      asUser("other"),
      asClient(uploader, ["evidence:write"]),
      asClient("another-client"),
      {},
    ]) {
      const res = await get(`/v1/alibis/${f?.id}`, h);
      expect(res.status).toBe(404);
      expect((await get(`/v1/alibis/${f?.id}.pdf`, h)).status).toBe(404);
    }
  });

  test("the pdf embeds the bundle the bundle route serves", async () => {
    const bundle = new Uint8Array(
      await (await get(`/v1/alibis/${f?.id}`, asUser(owner))).arrayBuffer(),
    );
    const res = await get(`/v1/alibis/${f?.id}.pdf`, asUser(owner));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${f?.id}.pdf"`);
    expect(await extractAlibi(new Uint8Array(await res.arrayBuffer()))).toEqual(bundle);
    const etag = res.headers.get("etag") as string;
    const again = await get(`/v1/alibis/${f?.id}.pdf`, { ...asUser(owner), "if-none-match": etag });
    expect(again.status).toBe(304);
  });

  test("the public receipt carries only what the log publishes", async () => {
    const res = await get(`/v1/alibis/${f?.id}/receipt`);
    expect(res.status).toBe(200);
    const body = new Uint8Array(await res.arrayBuffer());
    const receipt = decodeReceipt(body);
    expect(Object.keys(receipt).sort()).toEqual(
      [
        "alibi_id",
        "leaf",
        "leaf_hash",
        "tlog_proof",
        "timestamps",
        ...(f?.anchored ? ["anchor"] : []),
      ].sort(),
    );
    const text = new TextDecoder().decode(body);
    for (const secret of ["ref_salt", "payload_sd", "user_auth", "order_id", "manifest", "eval"]) {
      expect(text.includes(secret)).toBe(false);
    }
  });

  test("an unknown id is 404 on all three", async () => {
    const id = "01M00000000000000000000000";
    expect((await get(`/v1/alibis/${id}`, asUser(owner))).status).toBe(404);
    expect((await get(`/v1/alibis/${id}.pdf`, asUser(owner))).status).toBe(404);
    expect((await get(`/v1/alibis/${id}/receipt`)).status).toBe(404);
  });
});
