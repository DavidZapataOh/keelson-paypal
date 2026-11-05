import type { MiddlewareHandler } from "hono";
import { pino } from "pino";
import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { publishEvent } from "../src/events.ts";
import { testDb, testKv } from "./setup.ts";

const log = pino({ level: "silent" });
const deps = { db: testDb, kv: testKv };

const asPrincipal: MiddlewareHandler = async (c, next) => {
  const subject = c.req.header("x-test-subject");
  if (subject) c.set("principal", { kind: "user", subject });
  await next();
};

const app = createApp({ db: testDb, kv: testKv, log, authenticate: asPrincipal });
const ns = (subject: string): string => `user:${Buffer.from(subject).toString("base64url")}`;
const channel = (): string => `${ns("u1")}:${crypto.randomUUID().replaceAll("-", "")}`;

interface Frame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

class Sse {
  private buffer = "";
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;

  constructor(res: Response) {
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    this.reader = (res.body as ReadableStream<Uint8Array>).getReader();
  }

  async next(timeoutMs = 1000): Promise<Frame | undefined> {
    for (;;) {
      const end = this.buffer.indexOf("\n\n");
      if (end >= 0) {
        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        const frame: Frame = {};
        for (const line of raw.split("\n")) {
          if (line.startsWith(":")) frame.comment = line.slice(1).trim();
          else if (line.startsWith("id:")) frame.id = line.slice(3).trim();
          else if (line.startsWith("event:")) frame.event = line.slice(6).trim();
          else if (line.startsWith("data:")) frame.data = line.slice(5).trim();
        }
        return frame;
      }
      let timer: NodeJS.Timeout | undefined;
      this.pending ??= this.reader.read();
      const result = await Promise.race([
        this.pending,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (result !== undefined) this.pending = undefined;
      if (result === undefined || result.done) return undefined;
      this.buffer += this.decoder.decode(result.value, { stream: true });
    }
  }

  async event(timeoutMs = 1000): Promise<Frame> {
    for (;;) {
      const frame = await this.next(timeoutMs);
      if (frame === undefined) throw new Error("no event received");
      if (frame.comment === undefined) return frame;
    }
  }

  close(): Promise<void> {
    return this.reader.cancel();
  }
}

async function connect(name: string, lastEventId?: string): Promise<Sse> {
  const headers: Record<string, string> = { "x-test-subject": "u1" };
  if (lastEventId !== undefined) headers["last-event-id"] = lastEventId;
  const sse = new Sse(await app.request(`/v1/events?channel=${name}`, { headers }));
  expect((await sse.next())?.comment).toBe("connected");
  return sse;
}

test("delivers published events in order with id, event and data", async () => {
  const name = channel();
  const sse = await connect(name);
  const ids = [
    await publishEvent(deps, name, "m1", { n: 1 }),
    await publishEvent(deps, name, "m1", { n: 2 }),
    await publishEvent(deps, name, "m1", { n: 3 }),
  ];
  for (const [i, id] of ids.entries()) {
    const started = Date.now();
    const frame = await sse.event(100);
    expect(Date.now() - started).toBeLessThan(100);
    expect(frame).toEqual({ id: String(id), event: name, data: JSON.stringify({ n: i + 1 }) });
  }
  await sse.close();
});

test("replays only the events after Last-Event-ID, then continues live", async () => {
  const name = channel();
  const first = await publishEvent(deps, name, "m1", { n: 1 });
  const second = await publishEvent(deps, name, "m1", { n: 2 });
  const third = await publishEvent(deps, name, "m1", { n: 3 });
  const sse = await connect(name, String(first));
  expect((await sse.event()).id).toBe(String(second));
  expect((await sse.event()).id).toBe(String(third));
  expect(await sse.next(150)).toBeUndefined();
  const fourth = await publishEvent(deps, name, "m1", { n: 4 });
  expect((await sse.event(100)).id).toBe(String(fourth));
  await sse.close();
});

test("loses and repeats nothing when publishing during the replay", async () => {
  const name = channel();
  const first = await publishEvent(deps, name, "m1", { n: 0 });
  const ids: bigint[] = [];
  const publishing = (async () => {
    for (let n = 1; n <= 40; n++) ids.push(await publishEvent(deps, name, "m1", { n }));
  })();
  const sse = await connect(name, String(first));
  await publishing;
  const received: string[] = [];
  for (let i = 0; i < ids.length; i++) received.push(String((await sse.event()).id));
  expect(received).toEqual(ids.map(String));
  expect(await sse.next(150)).toBeUndefined();
  await sse.close();
});

test("releases the subscriber connection when the client goes away", async () => {
  const name = channel();
  const sse = await connect(name);
  const subscribers = async () => (await testKv.pubSubNumSub(`events:${name}`))[`events:${name}`];
  expect(Number(await subscribers())).toBe(1);
  await sse.close();
  const deadline = Date.now() + 1000;
  while (Number(await subscribers()) > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(Number(await subscribers())).toBe(0);
});

test("keeps ids in commit order with parallel publishers", async () => {
  const name = channel();
  const sse = await connect(name);
  const ids = await Promise.all(
    Array.from({ length: 50 }, (_, n) => publishEvent(deps, name, "m1", { n })),
  );
  const received: bigint[] = [];
  for (let i = 0; i < ids.length; i++) received.push(BigInt((await sse.event()).id as string));
  expect(received).toEqual([...ids].sort((a, b) => Number(a - b)));
  expect(await sse.next(150)).toBeUndefined();
  await sse.close();
});

const open = (target: string, headers: Record<string, string> = {}) =>
  app.request(`/v1/events?channel=${target}`, { headers: { "x-test-subject": "u1", ...headers } });
const slug = async (res: Response) =>
  ((await res.json()) as { type: string }).type.split("/").pop();

test("requires a principal and a channel", async () => {
  expect((await app.request("/v1/events?channel=public:x")).status).toBe(401);
  expect((await app.request("/v1/events", { headers: { "x-test-subject": "u1" } })).status).toBe(
    422,
  );
});

test("accepts public channels and the caller's own namespace only", async () => {
  const pub = await open("public:prices");
  expect(pub.status).toBe(200);
  await pub.body?.cancel();
  const bare = await open(ns("u1"));
  expect(bare.status).toBe(200);
  await bare.body?.cancel();
  for (const other of [ns("u2"), `${ns("u2")}:x`, `${ns("u1")}x`, "public:", "client:abc"]) {
    const res = await open(other);
    expect([other, res.status]).toEqual([other, 403]);
    expect(await slug(res)).toBe("forbidden-channel");
  }
});

test("rejects malformed channels and Last-Event-ID without opening a stream", async () => {
  for (const bad of ["a%0Ab", "a.b", "x".repeat(129)]) {
    const res = await open(bad);
    expect([bad.length, res.status, await slug(res)]).toEqual([bad.length, 400, "invalid-channel"]);
  }
  for (const id of ["abc", "-1", "", "9223372036854775808", "1".repeat(20)]) {
    const res = await open("public:x", { "last-event-id": id });
    expect([id, res.status, await slug(res)]).toEqual([id, 400, "invalid-last-event-id"]);
  }
  const max = await open("public:x", { "last-event-id": "9223372036854775807" });
  expect(max.status).toBe(200);
  await max.body?.cancel();
});

test("caps concurrent streams per principal", async () => {
  const held: Response[] = [];
  const user = { "x-test-subject": "capped" };
  for (let i = 0; i < 5; i++) {
    const res = await app.request(`/v1/events?channel=public:cap${i}`, { headers: user });
    expect(res.status).toBe(200);
    held.push(res);
  }
  const sixth = await app.request("/v1/events?channel=public:cap", { headers: user });
  expect([sixth.status, await slug(sixth)]).toEqual([429, "too-many-streams"]);
  const other = await open("public:cap");
  expect(other.status).toBe(200);
  await other.body?.cancel();
  await held[0]?.body?.cancel();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const again = await app.request("/v1/events?channel=public:cap", { headers: user });
  expect(again.status).toBe(200);
  await again.body?.cancel();
  for (const res of held.slice(1)) await res.body?.cancel();
});
