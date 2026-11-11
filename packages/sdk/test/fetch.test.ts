import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { keelsonFetch } from "../src/fetch.ts";

// A local HTTP server answers with the statuses under test; the SDK's fetch runs over the network
// against it exactly as it does against Keelson.
let server: Server | undefined;
afterEach(() => server?.close());

async function serve(
  answers: { status: number; headers?: Record<string, string>; body?: string }[],
) {
  const seen: IncomingMessage[] = [];
  server = createServer((req, res) => {
    seen.push(req);
    req.resume();
    const a = answers[Math.min(seen.length - 1, answers.length - 1)] ?? { status: 200 };
    res.writeHead(a.status, a.headers ?? {});
    res.end(a.body ?? "{}");
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen };
}

const fast = { baseDelayMs: 1, maxDelayMs: 50 };

test("a POST keeps one Idempotency-Key across its retries", async () => {
  const { url, seen } = await serve([{ status: 503 }, { status: 502 }, { status: 201 }]);
  const res = await keelsonFetch({ retry: fast })(url, { method: "POST", body: "{}" });
  expect(res.status).toBe(201);
  expect(seen).toHaveLength(3);
  const keys = new Set(seen.map((r) => r.headers["idempotency-key"]));
  expect(keys.size).toBe(1);
  expect([...keys][0]).toMatch(/^[0-9a-f-]{36}$/);
});

test("a key the caller set is sent as is; GETs carry none", async () => {
  const { url, seen } = await serve([{ status: 200 }]);
  const send = keelsonFetch({ retry: fast });
  await send(url, { method: "POST", headers: { "idempotency-key": "mine" }, body: "{}" });
  await send(url);
  expect(seen[0]?.headers["idempotency-key"]).toBe("mine");
  expect(seen[1]?.headers["idempotency-key"]).toBeUndefined();
});

test("429 waits Retry-After, and an in-progress idempotent request is retried", async () => {
  const { url, seen } = await serve([
    { status: 429, headers: { "retry-after": "0" } },
    {
      status: 409,
      headers: { "content-type": "application/problem+json" },
      body: JSON.stringify({ type: "https://keelson.finance/problems/idempotency-in-progress" }),
    },
    { status: 200 },
  ]);
  const res = await keelsonFetch({ retry: fast })(url, { method: "POST", body: "{}" });
  expect(res.status).toBe(200);
  expect(seen).toHaveLength(3);
});

test("retries stop after maxRetries and a refusal is not retried", async () => {
  const busy = await serve([{ status: 503 }]);
  const res = await keelsonFetch({ retry: { ...fast, maxRetries: 2 } })(busy.url);
  expect(res.status).toBe(503);
  expect(busy.seen).toHaveLength(3);
  server?.close();
  const refused = await serve([{ status: 422 }]);
  expect((await keelsonFetch({ retry: fast })(refused.url)).status).toBe(422);
  expect(refused.seen).toHaveLength(1);
});

test("an invalid token is dropped and the request sent once more with a fresh one", async () => {
  const { url, seen } = await serve([
    { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"' } },
    { status: 200 },
  ]);
  let n = 0;
  const auth = { token: async () => `t${n}`, invalidate: () => void n++ };
  const res = await keelsonFetch({ auth, retry: fast })(url);
  expect(res.status).toBe(200);
  expect(seen.map((r) => r.headers.authorization)).toEqual(["Bearer t0", "Bearer t1"]);
});
