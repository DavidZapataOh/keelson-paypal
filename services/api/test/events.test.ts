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
const channel = (): string => `test-${crypto.randomUUID()}`;

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

test("requires a principal and a channel", async () => {
  const anonymous = await app.request("/v1/events?channel=x");
  expect(anonymous.status).toBe(401);
  const missing = await app.request("/v1/events", { headers: { "x-test-subject": "u1" } });
  expect(missing.status).toBe(422);
  const bad = await app.request("/v1/events?channel=x", {
    headers: { "x-test-subject": "u1", "last-event-id": "abc" },
  });
  expect(bad.status).toBe(422);
});
