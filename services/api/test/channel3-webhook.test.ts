import { randomBytes } from "node:crypto";
import { sha256 } from "@keelson/core";
import { channel3Events, eq, timestamps } from "@keelson/db";
import { pino } from "pino";
import { Webhook } from "svix";
import { ulid } from "ulid";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { recentEvents } from "../src/channel3/webhook.ts";
import { testDb, testKv } from "./setup.ts";

// Each run signs with a fresh endpoint secret, the way the Svix portal issues one.
const secret = `whsec_${randomBytes(24).toString("base64")}`;
const signer = new Webhook(secret);
const app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  channel3WebhookSecret: secret,
});

/** An `offer.price.changed` event in the shape Channel3 documents, for a fresh product id. */
function priceChanged(productId = `p${ulid()}`) {
  return {
    id: randomBytes(20).toString("hex"),
    timestamp: new Date().toISOString(),
    type: "offer.price.changed",
    data: {
      subscription_id: ulid(),
      subject: {
        product_id: productId,
        domain: "shopwss.com",
        locale: { language: "en", country: "US", currency: "USD" },
        selection: [{ name: "Size", label: "L" }],
      },
      previous: { price: 26, compare_at_price: null, currency: "USD" },
      current: { price: 19.99, compare_at_price: 26, currency: "USD" },
    },
  };
}

function deliver(body: string, opts: { at?: Date; with?: Webhook; drop?: string } = {}) {
  const msgId = `msg_${ulid()}`;
  const at = opts.at ?? new Date();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "svix-id": msgId,
    "svix-timestamp": String(Math.floor(at.getTime() / 1000)),
    "svix-signature": (opts.with ?? signer).sign(msgId, at, body),
  };
  if (opts.drop) delete headers[opts.drop];
  return {
    msgId,
    headers,
    send: (b = body) => app.request("/webhooks/channel3", { method: "POST", headers, body: b }),
  };
}

const rowsFor = (id: string) =>
  testDb.select().from(channel3Events).where(eq(channel3Events.id, id));

describe("POST /webhooks/channel3", () => {
  test("a signed delivery is stored once, as its exact bytes, and stamped", async () => {
    const event = priceChanged();
    const body = JSON.stringify(event);
    const delivery = deliver(body);
    expect((await delivery.send()).status).toBe(204);
    expect((await delivery.send()).status).toBe(204);
    const redelivered = deliver(body);
    expect((await redelivered.send()).status).toBe(204);

    const rows = await rowsFor(event.id);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.body.toString("utf8")).toBe(body);
    expect(row?.contentHash.equals(Buffer.from(sha256(Buffer.from(body))))).toBe(true);
    expect(row).toMatchObject({
      type: "offer.price.changed",
      productId: event.data.subject.product_id,
      domain: "shopwss.com",
      svixId: delivery.msgId,
    });
    expect(row?.committedAt.toISOString()).toBe(event.timestamp);

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
  });

  test("an unknown event type is stored too", async () => {
    const event = { ...priceChanged(), type: "offer.something.new" };
    expect((await deliver(JSON.stringify(event)).send()).status).toBe(204);
    expect(await rowsFor(event.id)).toHaveLength(1);
  });

  test.each([
    ["the wrong secret", { with: new Webhook(`whsec_${randomBytes(24).toString("base64")}`) }],
    ["a timestamp six minutes old", { at: new Date(Date.now() - 6 * 60_000) }],
    ["no signature header", { drop: "svix-signature" }],
    ["no id header", { drop: "svix-id" }],
  ])("%s is refused and nothing is stored", async (_, opts) => {
    const event = priceChanged();
    const res = await deliver(JSON.stringify(event), opts).send();
    expect(res.status).toBe(400);
    expect(await rowsFor(event.id)).toEqual([]);
  });

  test("a signed event whose timestamp is not an RFC 3339 time of this century is refused", async () => {
    const event = { ...priceChanged(), timestamp: "+275760-09-13T00:00:00Z" };
    expect((await deliver(JSON.stringify(event)).send()).status).toBe(400);
    expect(await rowsFor(event.id)).toEqual([]);
  });

  test("a body altered by one byte is refused", async () => {
    const event = priceChanged();
    const body = JSON.stringify(event);
    const delivery = deliver(body);
    const altered = body.replace('"price":19.99', '"price":19.98');
    expect(altered).not.toBe(body);
    expect((await delivery.send(altered)).status).toBe(400);
    expect(await rowsFor(event.id)).toEqual([]);
  });

  test("without a secret the endpoint answers 503", async () => {
    const bare = createApp({ db: testDb, kv: testKv, log: pino({ level: "silent" }) });
    const res = await bare.request("/webhooks/channel3", { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
  });

  test("stored events summarize newest first, with prices in minor units", async () => {
    const productId = `p${ulid()}`;
    const older = {
      ...priceChanged(productId),
      timestamp: new Date(Date.now() - 60_000).toISOString(),
    };
    const newer = priceChanged(productId);
    for (const e of [older, newer]) {
      expect((await deliver(JSON.stringify(e)).send()).status).toBe(204);
    }
    const summaries = await recentEvents(testDb, productId, "shopwss.com");
    expect(summaries.map((s) => s.id)).toEqual([newer.id, older.id]);
    expect(summaries[0]).toMatchObject({
      type: "offer.price.changed",
      committedAt: newer.timestamp,
      current: { price_minor: "1999", compare_at_minor: "2600", currency: "USD" },
    });
    expect(await recentEvents(testDb, productId, "zumiez.com")).toEqual([]);
  });
});
