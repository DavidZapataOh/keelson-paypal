// Loads reflect-metadata before @keelson/alibi/verify pulls in @keelson/attest (see tee/attest.ts).
import "../src/tee/attest.ts";
import { ALIBI_MEDIA_TYPE, encodeAlibi } from "@keelson/alibi";
import { createChainReader, verifyAlibi } from "@keelson/alibi/verify";
import { pino } from "pino";
import { ulid } from "ulid";
import { describe, expect, test } from "vitest";
import { fixtures } from "../../../packages/alibi/test/fixtures.ts";
import { createApp } from "../src/app.ts";
import { testDb, testKv } from "./setup.ts";

const live = process.env.KEELSON_LIVE === "1";
const VERIFY = "https://verify.keelson.finance";
const base = { db: testDb, kv: testKv, log: pino({ level: "silent" }), verifyOrigin: VERIFY };
const offline = createApp(base);
const f = fixtures.find((x) => x.mode === "2of2") as (typeof fixtures)[number];

const post = (app: typeof offline, body: Uint8Array, type = ALIBI_MEDIA_TYPE) =>
  app.request("/v1/alibis/verify", {
    method: "POST",
    headers: { "content-type": type, "idempotency-key": ulid() },
    body: body as Uint8Array<ArrayBuffer>,
  });

const statuses = (checks: { id: string; status: string }[]) =>
  Object.fromEntries(checks.map((c) => [c.id, c.status]));

describe("POST /v1/alibis/verify", () => {
  test("a real Alibi gets the browser verifier's report", async () => {
    const res = await post(offline, f.bytes);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Awaited<ReturnType<typeof verifyAlibi>> & {
      reference: string;
    };
    expect(body.reference).toContain("https://verify.keelson.finance is the reference");
    const local = await verifyAlibi(f.bundle);
    expect(body.verdict).toBe("verified-offline");
    expect(statuses(body.checks)).toEqual(statuses(local.checks));
    expect(body.fields.length).toBeGreaterThan(0);
  });

  test("a tampered cart hash fails the same checks", async () => {
    const b = structuredClone(f.bundle);
    b.leaf_view.cart_hash = `A${String(b.leaf_view.cart_hash).slice(1)}`;
    const res = await post(offline, encodeAlibi(b));
    const body = (await res.json()) as {
      verdict: string;
      checks: { id: string; status: string }[];
    };
    const local = await verifyAlibi(b);
    expect(body.verdict).toBe("failed");
    expect(statuses(body.checks)).toEqual(statuses(local.checks));
  });

  test("a malformed bundle names the failing pointer", async () => {
    const b = JSON.parse(new TextDecoder().decode(f.bytes)) as Record<string, unknown>;
    b.alibi_id = 7;
    const res = await post(offline, new TextEncoder().encode(JSON.stringify(b)));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ type: expect.stringContaining("alibi-malformed") });
  });

  test("another media type and a body over 1 MiB are refused", async () => {
    expect((await post(offline, f.bytes, "application/json")).status).toBe(415);
    expect((await post(offline, new Uint8Array(2 * 1024 * 1024).fill(0x20))).status).toBe(413);
  });

  test.skipIf(!live)("against the chain, an anchored Alibi is verified", async () => {
    const app = createApp({ ...base, alibiChain: createChainReader() });
    const res = await post(app, f.bytes);
    const body = (await res.json()) as { verdict: string; rpc?: { custom: boolean } };
    expect(body.verdict).toBe(f.anchored ? "verified" : "verified-unanchored");
    expect(body.rpc?.custom).toBe(false);
  });
});

describe("cross-origin reads from the verifier", () => {
  const preflight = (path: string, origin: string) =>
    offline.request(path, {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "GET" },
    });

  test("the receipt and the timestamps are readable without credentials", async () => {
    for (const path of [`/v1/alibis/${f.id}/receipt`, `/v1/timestamps/${"a".repeat(64)}`]) {
      const res = await preflight(path, VERIFY);
      expect(res.headers.get("access-control-allow-origin")).toBe(VERIFY);
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });

  test("the full bundle is readable without credentials; other origins get no CORS headers", async () => {
    const bundle = await preflight(`/v1/alibis/${f.id}`, VERIFY);
    expect(bundle.headers.get("access-control-allow-origin")).toBe(VERIFY);
    expect(bundle.headers.get("access-control-allow-credentials")).toBeNull();
    expect(
      (await preflight(`/v1/alibis/${f.id}.pdf`, VERIFY)).headers.get(
        "access-control-allow-origin",
      ),
    ).toBeNull();
    expect(
      (await preflight(`/v1/alibis/${f.id}/receipt`, "https://evil.example")).headers.get(
        "access-control-allow-origin",
      ),
    ).toBeNull();
  });
});
