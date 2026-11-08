import { type Json, jcs, sha256, toHex } from "@keelson/core";
import { channel3Observations, eq, timestamps } from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { type Channel3Lookup, createChannel3 } from "../src/channel3/client.ts";
import { asClient, channel3Mandate } from "./channel3.ts";
import { testDb, testKv } from "./setup.ts";
import { headerPrincipal } from "./tee-live.ts";

const agent = asClient("observer-agent");

/** Channel3 at a port nothing listens on, counting the attempts the client makes. */
function refusedChannel3(): { channel3: Channel3Lookup; attempts: () => number } {
  let attempts = 0;
  const counting: typeof fetch = (input, init) => {
    attempts++;
    return fetch(input, init);
  };
  return {
    channel3: createChannel3("unused-key", "http://127.0.0.1:9", counting),
    attempts: () => attempts,
  };
}

const appWith = (channel3?: Channel3Lookup) =>
  createApp({
    db: testDb,
    kv: testKv,
    log: pino({ level: "silent" }),
    authenticate: headerPrincipal,
    ...(channel3 ? { channel3 } : {}),
  });

const agentView = {
  contentHash: `0x${"ab".repeat(32)}`,
  brand: "adidas",
  priceMinor: "2000",
  currency: "USD",
  available: true,
  selected: [{ name: "Color", label: "Black" }],
};

const post = (app: ReturnType<typeof createApp>, body: unknown, headers = agent) =>
  app.request("/v1/observations/channel3", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": ulid(), ...headers },
    body: JSON.stringify(body),
  });

const problemType = async (res: Response) => ((await res.json()) as { type: string }).type;

describe("POST /v1/observations/channel3", () => {
  test("without a Channel3 key it answers 503", async () => {
    const mandateId = await channel3Mandate();
    const res = await post(appWith(), {
      mandateId,
      url: "https://www.shopwss.com/products/jl4201a",
      agentView,
    });
    expect(res.status).toBe(503);
    expect(await problemType(res)).toMatch(/channel3-unconfigured$/);
  });

  test.each([
    "http://www.shopwss.com/products/jl4201a",
    "https://203.0.113.7/products/jl4201a",
    "https://[2001:db8::1]/products/jl4201a",
    "https://user:pass@www.shopwss.com/products/jl4201a",
    "https://localhost/products/jl4201a",
  ])("refuses %s", async (url) => {
    const mandateId = await channel3Mandate();
    const res = await post(appWith(refusedChannel3().channel3), { mandateId, url, agentView });
    expect(res.status).toBe(422);
  });

  test("an unknown mandate is 404 and a revoked one 409", async () => {
    const app = appWith(refusedChannel3().channel3);
    const url = "https://www.shopwss.com/products/jl4201a";
    expect((await post(app, { mandateId: ulid(), url, agentView })).status).toBe(404);
    const revoked = await channel3Mandate("REVOKED");
    expect((await post(app, { mandateId: revoked, url, agentView })).status).toBe(409);
  });

  test("Channel3 unreachable still records the observation, after one attempt", async () => {
    const { channel3, attempts } = refusedChannel3();
    const app = appWith(channel3);
    const mandateId = await channel3Mandate();
    const url = "https://www.shopwss.com/products/jl4201a";
    const res = await post(app, { mandateId, url, agentView });
    expect(res.status, await res.clone().text()).toBe(201);
    const body = (await res.json()) as {
      id: string;
      status: string;
      item: { bytes: string; content_hash: string };
      comparison: { price: string };
    };
    expect(attempts()).toBe(1);
    expect(body.status).toBe("unavailable");
    expect(body.comparison.price).toBe("unknown");
    const doc = JSON.parse(Buffer.from(body.item.bytes, "base64").toString("utf8"));
    expect(doc).toMatchObject({ status: "unavailable", error: "network", url });
    expect(doc).not.toHaveProperty("http_status");

    const [row] = await testDb
      .select()
      .from(channel3Observations)
      .where(eq(channel3Observations.id, body.id));
    expect(row?.status).toBe("unavailable");
    expect(toHex(row?.contentHash as Buffer)).toBe(body.item.content_hash);
    // The stamp is queued off the request path; it lands in the queue shortly after.
    const deadline = Date.now() + 2_000;
    let queued: unknown[] = [];
    while (queued.length < 2 && Date.now() < deadline) {
      queued = await testDb
        .select()
        .from(timestamps)
        .where(eq(timestamps.hash, row?.contentHash as Buffer));
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(queued).toHaveLength(2);

    const read = await app.request(`/v1/observations/channel3/${body.id}`, { headers: agent });
    expect(read.status).toBe(200);
    const stored = (await read.json()) as { document: Json; content_hash: string };
    expect(stored.content_hash).toBe(body.item.content_hash);
    expect(toHex(sha256(new TextEncoder().encode(jcs(stored.document))))).toBe(
      body.item.content_hash,
    );
    const other = await app.request(`/v1/observations/channel3/${body.id}`, {
      headers: asClient("another-agent"),
    });
    expect(other.status).toBe(404);
  });
});
