import { pino } from "pino";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { testDb, testKv } from "./setup.ts";

const DOCS = "https://docs.keelson.finance";
const APP = "https://app.keelson.finance";
const app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  appOrigin: APP,
  docsOrigin: DOCS,
});

const preflight = (path: string, origin: string, method = "POST") =>
  app.request(path, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": method,
      "access-control-request-headers": "content-type,idempotency-key",
    },
  });

describe("CORS for the documentation's try-it", () => {
  test("lets the docs verify an Alibi, without credentials", async () => {
    const res = await preflight("/v1/alibis/verify", DOCS);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(DOCS);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  test("lets the docs read the status and public receipts", async () => {
    for (const path of [
      "/status",
      "/v1/live-purchases",
      "/v1/log/bonds",
      "/v1/alibis/01M6ZWZJHWRRHQEYNJAT7NMSV8/receipt",
    ]) {
      const res = await preflight(path, DOCS, "GET");
      expect(res.headers.get("access-control-allow-origin"), path).toBe(DOCS);
      expect(res.headers.get("access-control-allow-credentials"), path).toBeNull();
    }
  });

  test("docs origin is refused on /v1/mandates and never gets credentials", async () => {
    const res = await preflight("/v1/mandates", DOCS);
    expect(res.headers.get("access-control-allow-origin")).not.toBe(DOCS);
    const read = await app.request("/v1/alibis/01M6ZWZJHWRRHQEYNJAT7NMSV8/receipt", {
      headers: { origin: DOCS },
    });
    expect(read.headers.get("access-control-allow-credentials")).toBeNull();
  });

  test("the app keeps its credentialed CORS", async () => {
    const res = await preflight("/v1/mandates", APP);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
});
