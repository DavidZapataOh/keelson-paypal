import { randomBytes } from "node:crypto";
import { eq, mandates, purchases } from "@keelson/db";
import { context, SpanKind, trace } from "@opentelemetry/api";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { pino } from "pino";
import { ulid } from "ulid";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import {
  PurchaseTimings,
  parseServerTiming,
  purchaseTimings,
  serverTiming,
} from "../src/server-timing.ts";
import { channel3Mandate } from "./channel3.ts";
import { testDb, testKv } from "./setup.ts";
import { headerPrincipal } from "./tee-live.ts";

describe("Server-Timing", () => {
  test("round-trips, with names reduced to token characters", () => {
    const header = serverTiming({
      "step.LOGGED": 812.345,
      "out.Log.Keelson.Finance:443": 120,
      "db.LOGGED": 3.04,
    });
    expect(header).toBe(
      "step.LOGGED;dur=812.3, out.log.keelson.finance_443;dur=120.0, db.LOGGED;dur=3.0",
    );
    expect(parseServerTiming(header)).toEqual({
      "step.LOGGED": 812.3,
      "out.log.keelson.finance_443": 120,
      "db.LOGGED": 3,
    });
  });

  test("a purchase's steps are timed with their outbound calls and Postgres time", async () => {
    const timings = new PurchaseTimings(testKv);
    const tracer = new TracerProvider({ spanProcessors: [timings] }).getTracer("t");
    const id = ulid();
    const step = tracer.startSpan("purchase.LOGGED", { attributes: { "purchase.id": id } });
    const inside = trace.setSpan(context.active(), step);
    tracer
      .startSpan(
        "POST",
        { kind: SpanKind.CLIENT, attributes: { "server.address": "log.keelson.finance" } },
        inside,
      )
      .end();
    tracer.startSpan("pg.query:SELECT", { kind: SpanKind.CLIENT }, inside).end();
    tracer.startSpan("leg.a", { kind: SpanKind.INTERNAL }, inside).end();
    tracer.startSpan("outside", {}, context.active()).end();
    step.end();
    await timings.forceFlush();
    const read = await purchaseTimings(testKv, id);
    expect(Object.keys(read).sort()).toEqual([
      "db.LOGGED",
      "int.leg.a",
      "out.log.keelson.finance",
      "step.LOGGED",
    ]);
    expect(read["step.LOGGED"]).toBeGreaterThanOrEqual(0);
  });

  describe("on GET /v1/purchases/{id}", () => {
    const app = createApp({
      db: testDb,
      kv: testKv,
      log: pino({ level: "silent" }),
      authenticate: headerPrincipal,
    });
    const asUser = (sub: string) => ({
      "x-test-principal": JSON.stringify({ kind: "user", subject: sub }),
    });

    async function timedPurchase() {
      const mandateId = await channel3Mandate();
      const [m] = await testDb
        .select({ userId: mandates.userId })
        .from(mandates)
        .where(eq(mandates.id, mandateId));
      const id = ulid();
      await testDb.insert(purchases).values({
        id,
        mandateId,
        clientId: "observer-agent",
        state: "LOGGED",
        merchantId: "mrc_alfred",
        currency: "USD",
        amountMinor: 295n,
        cartHash: randomBytes(32),
        countersign: { issuedAt: String(Math.floor(Date.now() / 1000)) },
      } as typeof purchases.$inferInsert);
      await testKv.hSet(`purchase:timing:${id}`, { "step.COUNTERSIGNED": "412.5" });
      return { id, owner: m?.userId as string };
    }

    test("the purchase's reader gets its steps", async () => {
      const { id, owner } = await timedPurchase();
      const res = await app.request(`/v1/purchases/${id}`, { headers: asUser(owner) });
      expect(res.status).toBe(200);
      expect(parseServerTiming(res.headers.get("server-timing") ?? "")).toEqual({
        "step.COUNTERSIGNED": 412.5,
      });
    });

    test("nobody else does, nor anyone without a principal", async () => {
      const { id } = await timedPurchase();
      const other = await app.request(`/v1/purchases/${id}`, { headers: asUser("kls_usr_other") });
      expect(other.status).toBe(404);
      expect(other.headers.get("server-timing")).toBeNull();
      const anonymous = await app.request(`/v1/purchases/${id}`);
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get("server-timing")).toBeNull();
    });
  });
});
