import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  APIConnectionTimeoutError,
  AuthenticationError,
  ConflictError,
  InternalServerError,
  Keelson,
  NotFoundError,
  OutcomeUnknownError,
  staticToken,
  UnprocessableEntityError,
} from "../src/index.ts";
import { drop, hang, json, problem, scriptedServer } from "./server.ts";

let s: Awaited<ReturnType<typeof scriptedServer>>;
let keelson: Keelson;

beforeAll(async () => {
  s = await scriptedServer();
});
afterAll(() => s.close());
beforeEach(() => {
  keelson = new Keelson({ baseUrl: s.url, auth: staticToken("t0"), timeoutMs: 2_000 });
});

const KEY = /^[\w-]{1,255}$/;
const post = (k: Keelson = keelson, init: { idempotencyKey?: string } = {}) =>
  k.request("POST", "/v1/evidence", { body: { a: 1 }, ...init });

describe("idempotency keys", () => {
  test("one Idempotency-Key is kept across 503, 502 then 201", async () => {
    s.script(problem(503, "unavailable"), problem(502, "bad-gateway"), json(201, { ok: true }));
    const { data } = await post();
    expect(data).toEqual({ ok: true });
    expect(s.seen).toHaveLength(3);
    const keys = s.seen.map((r) => r.headers["idempotency-key"]);
    expect(keys[0]).toMatch(KEY);
    expect(new Set(keys).size).toBe(1);
  });

  test("a POST carries an Idempotency-Key even with maxRetries 0", async () => {
    s.script(json(201, {}));
    await post(new Keelson({ baseUrl: s.url, auth: staticToken("t0"), maxRetries: 0 }));
    expect(s.seen[0]?.headers["idempotency-key"]).toMatch(KEY);
  });

  test("a caller's key is kept, and a GET sends none", async () => {
    s.script(json(201, {}), json(200, {}));
    await post(keelson, { idempotencyKey: "my-key" });
    await keelson.request("GET", "/v1/purchases/x");
    expect(s.seen[0]?.headers["idempotency-key"]).toBe("my-key");
    expect(s.seen[1]?.headers["idempotency-key"]).toBeUndefined();
  });
});

describe("retries", () => {
  test("429 waits Retry-After, and 409 idempotency-in-progress is retried", async () => {
    s.script(
      problem(429, "rate-limited", {}, { "retry-after": "1" }),
      problem(409, "idempotency-in-progress"),
      json(201, {}),
    );
    const t0 = Date.now();
    await post();
    expect(s.seen).toHaveLength(3);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_000);
  });

  test("422 and 409 purchase-exists are not retried", async () => {
    s.script(problem(422, "invalid-request"));
    await expect(post()).rejects.toBeInstanceOf(UnprocessableEntityError);
    expect(s.seen).toHaveLength(1);
    s.script(problem(409, "purchase-exists", { purchaseId: "P1" }));
    const err = await post().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).type).toBe("purchase-exists");
    expect((err as ConflictError).problem.purchaseId).toBe("P1");
    expect(s.seen).toHaveLength(1);
  });

  test("stops after maxRetries and throws the last error", async () => {
    s.script(problem(500, "internal"), problem(500, "internal"), problem(500, "internal"));
    await expect(post()).rejects.toBeInstanceOf(InternalServerError);
    expect(s.seen).toHaveLength(3);
  });
});

describe("errors", () => {
  test("problem+json maps to a typed error with the request id", async () => {
    s.script(problem(404, "not-found", { detail: "No such purchase." }));
    const err = (await keelson.request("GET", "/v1/purchases/x").catch((e) => e)) as NotFoundError;
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
    expect(err.type).toBe("not-found");
    expect(err.detail).toBe("No such purchase.");
    expect(err.requestId).toBe("req_1");
    expect(err.message).toContain("No such purchase.");
  });

  test("a 401 invalid_token refreshes the token once", async () => {
    let n = 0;
    const k = new Keelson({
      baseUrl: s.url,
      auth: { token: async () => `t${n++}` },
    });
    s.script(
      problem(401, "unauthorized", {}, { "www-authenticate": 'Bearer error="invalid_token"' }),
      json(200, { ok: 1 }),
    );
    await k.request("GET", "/v1/purchases/x");
    expect(s.seen.map((r) => r.headers.authorization)).toEqual(["Bearer t0", "Bearer t1"]);
    s.script(
      problem(401, "unauthorized", {}, { "www-authenticate": 'Bearer error="invalid_token"' }),
      problem(401, "unauthorized", {}, { "www-authenticate": 'Bearer error="invalid_token"' }),
    );
    await expect(k.request("GET", "/v1/purchases/x")).rejects.toBeInstanceOf(AuthenticationError);
    expect(s.seen).toHaveLength(2);
  });

  test("an attempt that outlasts timeoutMs is an APIConnectionTimeoutError", async () => {
    s.script(hang);
    const k = new Keelson({
      baseUrl: s.url,
      auth: staticToken("t"),
      timeoutMs: 200,
      maxRetries: 0,
    });
    await expect(k.request("GET", "/v1/purchases/x")).rejects.toBeInstanceOf(
      APIConnectionTimeoutError,
    );
  });

  test("an http baseUrl that is not loopback is refused", () => {
    expect(
      () => new Keelson({ baseUrl: "http://api.example.com", auth: staticToken("t") }),
    ).toThrow(/https/);
  });

  test("a countersign that never gets an answer is OutcomeUnknownError, never a second purchase", async () => {
    s.script(drop, drop, drop);
    const err = (await keelson
      .request("POST", "/v1/countersign", { body: { requestId: "01JX0000000000000000000000" } })
      .catch((e) => e)) as OutcomeUnknownError;
    expect(err).toBeInstanceOf(OutcomeUnknownError);
    expect(err.requestId).toBe("01JX0000000000000000000000");
    expect(new Set(s.seen.map((r) => r.headers["idempotency-key"])).size).toBe(1);
  });
});

describe("a countersign still running on the server", () => {
  test("idempotency-in-progress until retries run out is OutcomeUnknownError", async () => {
    s.script(
      problem(409, "idempotency-in-progress"),
      problem(409, "idempotency-in-progress"),
      problem(409, "idempotency-in-progress"),
    );
    const err = await keelson
      .request("POST", "/v1/countersign", { body: { requestId: "01JX0000000000000000000001" } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutcomeUnknownError);
  });

  test("an answer cut off mid-body is retried with the same key", async () => {
    s.script(
      (res) => {
        res.writeHead(201, { "content-type": "application/json", "content-length": "100" });
        res.write('{"ok":');
        setTimeout(() => res.socket?.destroy(), 20);
      },
      json(201, { ok: true }),
    );
    const { data } = await keelson.request("POST", "/v1/evidence", { body: { a: 1 } });
    expect(data).toEqual({ ok: true });
    expect(new Set(s.seen.map((r) => r.headers["idempotency-key"])).size).toBe(1);
  });
});

describe("streams", () => {
  test("a stream outlives the per-attempt timeout while it keeps sending", async () => {
    s.script((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const t = setInterval(() => {
        res.write(++n < 8 ? ": heartbeat\n\n" : "id: 1\ndata: hello\n\n");
        if (n >= 8) clearInterval(t);
      }, 100);
    });
    const k = new Keelson({ baseUrl: s.url, auth: staticToken("t"), timeoutMs: 300 });
    const first = await k.events.stream("public:test").next();
    expect(first.value).toMatchObject({ id: "1", data: "hello" });
  });
});

describe("Alibis", () => {
  test("your own Alibi is read with your token; a public one needs none", async () => {
    s.script(json(200, {}), json(200, {}));
    await keelson.alibis.retrieve("01M75ZQSJDFE8K76ZKZT08X1B2");
    await new Keelson({ baseUrl: s.url, auth: null }).alibis.retrieve("01M75ZQSJDFE8K76ZKZT08X1B2");
    expect(s.seen.map((r) => r.headers.authorization)).toEqual(["Bearer t0", undefined]);
  });
});
