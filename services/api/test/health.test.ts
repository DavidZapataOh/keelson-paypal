import { pino } from "pino";
import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { testDb } from "./setup.ts";

const app = createApp({ db: testDb, log: pino({ level: "silent" }) });

test("GET /health returns ok", async () => {
  const res = await app.request("/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});
