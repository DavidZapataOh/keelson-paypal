import { Writable } from "node:stream";
import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { createLogger } from "../src/logger.ts";
import { testDb, testKv } from "./setup.ts";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      for (const line of String(chunk).split("\n")) if (line) lines.push(JSON.parse(line));
      done();
    },
  });
  return { lines, log: createLogger(stream) };
}

test("logs one line per request with the route pattern and no credentials", async () => {
  const { lines, log } = capture();
  const app = createApp({ db: testDb, kv: testKv, log });
  const res = await app.request("/health?token=abc", {
    headers: { authorization: "Bearer secret", cookie: "session=secret" },
  });
  expect(res.status).toBe(200);

  const entry = lines.find((l) => l.msg === "request");
  expect(entry).toMatchObject({ method: "GET", route: "/health", status: 200 });
  expect(entry?.req_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(typeof entry?.ms).toBe("number");
  expect(JSON.stringify(lines)).not.toContain("secret");
});

test("reuses the incoming x-request-id", async () => {
  const { lines, log } = capture();
  const app = createApp({ db: testDb, kv: testKv, log });
  await app.request("/health", { headers: { "x-request-id": "req-123" } });
  expect(lines.find((l) => l.msg === "request")?.req_id).toBe("req-123");
});

test("redacts credential headers in structured fields", () => {
  const { lines, log } = capture();
  log.info({ req: { headers: { authorization: "Bearer secret", cookie: "a=secret" } } }, "probe");
  expect(JSON.stringify(lines)).not.toContain("secret");
});
