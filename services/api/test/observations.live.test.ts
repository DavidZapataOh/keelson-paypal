import { randomBytes } from "node:crypto";
import { type Json, jcs, normalizeProduct, sha256, toHex } from "@keelson/core";
import { itemLeaf } from "@keelson/evidence";
import { verifyTimestamp } from "@keelson/timestamp";
import { pino } from "pino";
import { Webhook } from "svix";
import { ulid } from "ulid";
import { afterAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { createChannel3 } from "../src/channel3/client.ts";
import { startStampWorker } from "../src/timestamps/worker.ts";
import { asClient, capturedLookup, channel3Mandate } from "./channel3.ts";
import { testDb, testKv } from "./setup.ts";
import { headerPrincipal } from "./tee-live.ts";

const live = process.env.KEELSON_LIVE === "1" && Boolean(process.env.CHANNEL3_API_KEY);

describe.skipIf(!live)("Channel3 observation, live", { timeout: 60_000 }, () => {
  const log = pino({ level: "silent" });
  const stamps = startStampWorker({ db: testDb, kv: testKv, log });
  afterAll(() => stamps.stop());
  const secret = `whsec_${randomBytes(24).toString("base64")}`;
  const app = createApp({
    channel3WebhookSecret: secret,
    db: testDb,
    kv: testKv,
    log,
    authenticate: headerPrincipal,
    stamps,
    channel3: createChannel3(process.env.CHANNEL3_API_KEY as string),
  });
  const agent = asClient("observer-agent");

  test("a catalog SKU is observed, stored, sealed and stamped by two TSAs", async () => {
    const fixture = capturedLookup("shopwss-com");
    const product = normalizeProduct(fixture.product);
    const offer = product.offers.find((o) => o.domain === "shopwss.com");
    const mandateId = await channel3Mandate();
    // A signed offer event for the same product and merchant, received before the decision.
    const event = {
      id: randomBytes(20).toString("hex"),
      timestamp: new Date().toISOString(),
      type: "offer.availability.changed",
      data: {
        subscription_id: ulid(),
        subject: { product_id: product.id, domain: "shopwss.com", selection: null },
        previous: "OutOfStock",
        current: "InStock",
      },
    };
    const payload = JSON.stringify(event);
    const msgId = `msg_${ulid()}`;
    const at = new Date();
    const delivered = await app.request("/webhooks/channel3", {
      method: "POST",
      headers: {
        "svix-id": msgId,
        "svix-timestamp": String(Math.floor(at.getTime() / 1000)),
        "svix-signature": new Webhook(secret).sign(msgId, at, payload),
      },
      body: payload,
    });
    expect(delivered.status).toBe(204);

    const res = await app.request("/v1/observations/channel3", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...agent },
      body: JSON.stringify({
        mandateId,
        url: fixture.url,
        agentView: {
          contentHash: `0x${"ab".repeat(32)}`,
          brand: product.brand,
          priceMinor: offer?.priceMinor,
          currency: "USD",
          available: offer?.availability === "InStock",
          selected: product.selected,
        },
      }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const body = (await res.json()) as {
      id: string;
      status: string;
      item: {
        type: string;
        mediaType: string;
        salt: string;
        bytes: string;
        content_hash: string;
        leaf: string;
      };
      comparison: { brand: string; offerDomain: string };
    };
    expect(body.status).toBe("ok");
    expect(body.comparison).toMatchObject({ brand: "match", offerDomain: "shopwss.com" });

    const bytes = Buffer.from(body.item.bytes, "base64");
    const hash = sha256(bytes);
    expect(toHex(hash)).toBe(body.item.content_hash);
    const document = JSON.parse(bytes.toString("utf8")) as Json;
    expect(toHex(sha256(new TextEncoder().encode(jcs(document))))).toBe(body.item.content_hash);
    expect(document).toMatchObject({
      v: "keelson.channel3.observation/1",
      http_status: 200,
      webhook_events: [
        {
          id: event.id,
          type: "offer.availability.changed",
          committed_at: event.timestamp,
          current: "InStock",
        },
      ],
    });
    expect(body.item.leaf).toBe(
      toHex(
        itemLeaf({
          type: "channel3.observation",
          mediaType: "application/json",
          contentHash: hash,
          salt: Buffer.from(body.item.salt, "base64"),
        }),
      ),
    );

    const deadline = Date.now() + 5_000;
    let stamped: { tsa: string; token: string }[] = [];
    while (stamped.length < 2 && Date.now() < deadline) {
      const r = await app.request(`/v1/timestamps/${body.item.content_hash.slice(2)}`);
      if (r.status === 200) stamped = ((await r.json()) as { stamps: typeof stamped }).stamps;
      if (stamped.length < 2) await new Promise((done) => setTimeout(done, 100));
    }
    expect(stamped.map((s) => s.tsa).sort()).toEqual(["digicert", "sigstore"]);
    for (const s of stamped) {
      expect((await verifyTimestamp(Buffer.from(s.token, "base64"), hash)).tsa).toBe(s.tsa);
    }
  });
});
