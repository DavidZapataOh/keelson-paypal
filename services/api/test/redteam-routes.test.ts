import { jcs } from "@keelson/core";
import { attacks, eq, redTeamCampaigns } from "@keelson/db";
import {
  type Attack,
  append,
  failedAttack,
  GENESIS,
  type Header,
  type Line,
  score,
  summarize,
  TEMPLATES,
  verify,
} from "@keelson/redteam";
import { pino } from "pino";
import { ulid } from "ulid";
import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { testDb, testKv } from "./setup.ts";

const app = createApp({ db: testDb, kv: testKv, log: pino({ level: "silent" }) });

/** Attacks whose agents proposed nothing: real ledger lines, judged as the campaign judges them. */
function failed(from: number, count: number): Attack[] {
  return Array.from({ length: count }, (_, i) => {
    const seq = from + i;
    const t = TEMPLATES[seq % TEMPLATES.length] as (typeof TEMPLATES)[number];
    return failedAttack(
      {
        seq,
        round: 1,
        template: t.id,
        class: t.class,
        split: seq % 5 === 0 ? "holdout" : "seen",
        mutation: { by: "fallback", seed: seq, text: `mutation ${seq}`, placements: [] },
        backbone: seq % 7 === 0 ? "guarded" : "vulnerable",
      },
      "agent timed out",
    );
  });
}

/** Stores a campaign as the workflow does: header first, attacks by round, summary at the end. */
class Stored {
  readonly id = ulid();
  readonly lines: string[] = [];
  private prev = GENESIS;
  private readonly all: Attack[] = [];

  private chain(line: Line): string {
    const out = append(this.prev, line);
    this.prev = out.hash;
    this.lines.push(out.line);
    return out.line;
  }

  async start(): Promise<this> {
    const header: Header = {
      kind: "header",
      v: "keelson.redteam/1",
      campaign: this.id,
      now: "2026-11-10T12:00:00.000Z",
      store: "https://store.keelson.finance",
      mandate: {},
      evaluator: {},
      config: {},
      templates: [],
      commit: "test",
    };
    await testDb.insert(redTeamCampaigns).values({ id: this.id, header: this.chain(header) });
    return this;
  }

  async round(batch: Attack[]): Promise<void> {
    this.all.push(...batch);
    await testDb.insert(attacks).values(
      batch.map((a) => {
        const line = this.chain(a);
        return {
          id: ulid(),
          campaign: this.id,
          seq: a.seq,
          backbone: a.backbone,
          payloadHash: Buffer.alloc(32),
          outcome: "NO_EFFECT" as const,
          line,
          hash: Buffer.from(this.prev, "hex"),
        };
      }),
    );
  }

  async finish(): Promise<void> {
    const line = this.chain(summarize(this.all, 1_000));
    await testDb
      .update(redTeamCampaigns)
      .set({ summary: line, head: Buffer.from(this.prev, "hex"), finishedAt: new Date() })
      .where(eq(redTeamCampaigns.id, this.id));
  }
}

/** Reads server-sent events until `until` returns true or `ms` pass. */
async function events(res: Response, until: (e: { event: string; data: string }[]) => boolean) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const seen: { event: string; data: string }[] = [];
  let buffer = "";
  const deadline = Date.now() + 10_000;
  while (!until(seen) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const frame = buffer.slice(0, end).split("\n");
      buffer = buffer.slice(end + 2);
      const event = frame
        .find((l) => l.startsWith("event:"))
        ?.slice(6)
        .trim();
      const data =
        frame
          .find((l) => l.startsWith("data:"))
          ?.slice(5)
          .trim() ?? "";
      if (event) seen.push({ event, data });
    }
  }
  await reader.cancel();
  return seen;
}

test("a finished campaign's ledger downloads byte for byte and its scoreboard recomputes from it", async () => {
  const c = await new Stored().start();
  await c.round(failed(0, 8));
  await c.round(failed(8, 6));
  await c.finish();

  const list = (await (await app.request("/v1/redteam/campaigns")).json()) as {
    campaigns: { id: string; attacks: number; finishedAt: string | null }[];
  };
  expect(list.campaigns.find((x) => x.id === c.id)).toMatchObject({ attacks: 14 });

  const res = await app.request(`/v1/redteam/campaigns/${c.id}/ledger`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/jsonl");
  expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${c.id}.jsonl"`);
  expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  const text = await res.text();
  expect(text).toBe(`${c.lines.join("\n")}\n`);
  const downloaded = text.split("\n").filter((l) => l !== "");
  expect(verify(downloaded)).toMatchObject({ ok: true, lines: 16 });

  const published = await app.request(`/v1/redteam/campaigns/${c.id}/scoreboard`);
  expect(published.headers.get("content-type")).toBe("application/json");
  expect(published.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  const body = await published.text();
  expect(body).toBe(jcs(score(downloaded) as never));
  expect(JSON.parse(body)).toMatchObject({ complete: true, attacks: 14, lines: 16 });
  // Served again from memory, the same bytes.
  expect(await (await app.request(`/v1/redteam/campaigns/${c.id}/scoreboard`)).text()).toBe(body);
});

test("a running campaign is published as far as it goes, and never cached", async () => {
  const c = await new Stored().start();
  await c.round(failed(0, 3));
  const res = await app.request(`/v1/redteam/campaigns/${c.id}/scoreboard`);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(JSON.parse(await res.text())).toMatchObject({ complete: false, attacks: 3, lines: 4 });
  const ledger = await app.request(`/v1/redteam/campaigns/${c.id}/ledger`);
  expect(ledger.headers.get("cache-control")).toBe("no-store");
});

test("the stream sends the scoreboard as the ledger grows and ends with the campaign", async () => {
  const c = await new Stored().start();
  await c.round(failed(0, 4));
  const res = await app.request(`/v1/redteam/campaigns/${c.id}/scoreboard/stream`);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const grow = (async () => {
    await new Promise((r) => setTimeout(r, 300));
    await c.round(failed(4, 4));
    await c.finish();
  })();
  const seen = await events(res, (e) => e.some((x) => x.event === "end"));
  await grow;
  const boards = seen.filter((e) => e.event === "scoreboard").map((e) => JSON.parse(e.data));
  expect(boards[0]).toMatchObject({ attacks: 4, complete: false });
  expect(boards.at(-1)).toMatchObject({ attacks: 8, complete: true });
  expect(seen.at(-1)?.event).toBe("end");
  expect(seen.at(-2)?.data).toBe(jcs(score(c.lines) as never));
});

test("an unknown or malformed campaign is refused", async () => {
  expect((await app.request(`/v1/redteam/campaigns/${ulid()}/ledger`)).status).toBe(404);
  expect((await app.request(`/v1/redteam/campaigns/${ulid()}/scoreboard`)).status).toBe(404);
  expect((await app.request(`/v1/redteam/campaigns/${ulid()}/scoreboard/stream`)).status).toBe(404);
  expect((await app.request("/v1/redteam/campaigns/nope/scoreboard")).status).toBe(422);
});
