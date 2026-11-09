import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { paypalEvents } from "@keelson/db";
import { CertStore } from "@keelson/paypal";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { createLogger } from "../src/logger.ts";
import { testDb, testKv } from "./setup.ts";

/** A real sandbox signing certificate and its cert URL. */
const CERT_URL =
  "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-ab66f33d";
const CERT_PEM = readFileSync(
  new URL(
    "../../../packages/paypal/test/fixtures/webhooks/cert-360caa42-fca2a594-ab66f33d.pem",
    import.meta.url,
  ),
  "utf8",
);
const SENT = "2024-05-16T05:19:23Z";
const SIG = Buffer.alloc(256, 7).toString("base64");

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { lines, log: createLogger(stream) };
}

function seededCerts(): CertStore {
  const key = `paypal:cert:${createHash("sha256").update(CERT_URL).digest("hex")}`;
  return new CertStore("sandbox", {
    get: async (k) => (k === key ? CERT_PEM : null),
    set: async () => {},
  });
}

function appWith(opts: { certs?: CertStore; now?: Date; configured?: boolean } = {}) {
  const { lines, log } = capture();
  const certs = opts.certs ?? seededCerts();
  const now = opts.now ?? new Date(new Date(SENT).getTime() + 1_000);
  const app = createApp({
    db: testDb,
    kv: testKv,
    log,
    ...(opts.configured === false
      ? {}
      : { paypalWebhook: { webhookId: "4JH86294D6297924G", certs, now: () => now } }),
  });
  return { app, lines, certs };
}

const deliver = (
  app: ReturnType<typeof appWith>["app"],
  body: string | Uint8Array<ArrayBuffer>,
  over: Record<string, string | undefined> = {},
) => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "paypal-transmission-id": "c1e6a2b0-bd4b-11f0-9ba1-f1a7b1e6e1d3",
    "paypal-transmission-time": SENT,
    "paypal-transmission-sig": SIG,
    "paypal-cert-url": CERT_URL,
    "paypal-auth-algo": "SHA256withRSA",
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete headers[k];
    else headers[k] = v;
  }
  return app.request("/webhooks/paypal", { method: "POST", headers, body });
};

const BODY = JSON.stringify({
  id: "WH-REFUSED",
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  resource_type: "capture",
  resource: { id: "0" },
});

async function count(): Promise<number> {
  return (await testDb.select({ id: paypalEvents.id }).from(paypalEvents)).length;
}

describe("POST /webhooks/paypal refusals", () => {
  test("answers 503 without a configured webhook id", async () => {
    const { app } = appWith({ configured: false });
    const res = await deliver(app, BODY);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      type: expect.stringMatching(/paypal-webhook-unconfigured$/),
    });
  });

  test("answers 413 for a body over 512 KiB before verifying it", async () => {
    const { app, certs } = appWith();
    const res = await deliver(app, new Uint8Array(600 * 1024));
    expect(res.status).toBe(413);
    expect(certs.fetches).toBe(0);
  });

  test.each([
    ["a missing header", { "paypal-auth-algo": undefined }, "headers"],
    ["another algorithm", { "paypal-auth-algo": "SHA1withRSA" }, "algorithm"],
    ["a delivery 301 s old", {}, "stale", new Date(new Date(SENT).getTime() + 301_000)],
    [
      "a cert URL off PayPal's host",
      {
        "paypal-cert-url":
          "https://api.sandbox.paypal.com.evil.example/v1/notifications/certs/CERT-x",
      },
      "cert_url",
    ],
    ["a signature PayPal's certificate did not make", {}, "signature"],
  ] as const)("refuses %s with 400 and stores nothing", async (_, over, code, now?: Date) => {
    const { app, lines, certs } = appWith(now ? { now } : {});
    const before = await count();
    const res = await deliver(app, BODY, over);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({
      type: "https://api.keelson.finance/problems/invalid-signature",
      code,
    });
    expect(await count()).toBe(before);
    if (code !== "signature") expect(certs.fetches).toBe(0);
    const logged = lines.join("");
    expect(logged).toContain(`"code":"${code}"`);
    expect(logged).not.toContain(SIG);
    expect(logged).not.toContain("WH-REFUSED");
  });
});
