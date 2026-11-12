import { SpanKind } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace";
import type { RedisClientType } from "redis";

/** How long a purchase's step timings stay readable. */
const TTL_S = 3600;
const key = (purchaseId: string) => `purchase:timing:${purchaseId}`;
const ms = (s: ReadableSpan) => s.duration[0] * 1_000 + s.duration[1] / 1e6;

/** A `Server-Timing` metric name: RFC 9110 `token` characters only, lowercase for hosts. */
const token = (name: string) => name.replace(/[^!#$%&'*+\-.^_`|~0-9A-Za-z]/g, "_");

/**
 * The `Server-Timing` header (W3C Server Timing) of a purchase's timings: `step.<state>` for
 * each step, `out.<host>` for the calls its steps made, `int.<name>` for the work inside them and
 * `db.<state>` for each step's Postgres time.
 */
export function serverTiming(timings: Record<string, number>): string {
  return Object.entries(timings)
    .map(([name, dur]) => {
      const [kind, ...rest] = name.split(".");
      const what = rest.join(".");
      return `${token(`${kind}.${kind === "out" ? what.toLowerCase() : what}`)};dur=${dur.toFixed(1)}`;
    })
    .join(", ");
}

/**
 * Reads a `Server-Timing` header back into its metrics, as clients of the API do.
 * @internal
 */
export function parseServerTiming(header: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of header.split(",")) {
    const [name, ...params] = entry.trim().split(";");
    const dur = params.map((p) => p.trim()).find((p) => p.startsWith("dur="));
    if (name && dur) out[name] = Number(dur.slice(4));
  }
  return out;
}

/** The timings recorded for a purchase so far. */
export async function purchaseTimings(
  kv: RedisClientType,
  purchaseId: string,
): Promise<Record<string, number>> {
  const raw = await kv.hGetAll(key(purchaseId));
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v)]));
}

interface Step {
  purchaseId: string;
  state: string;
  out: Map<string, number>;
  internal: Map<string, number>;
  db: number;
}

/**
 * Times each `purchase.<state>` span with what ran inside it, and keeps the totals in Valkey for
 * an hour, keyed by the purchase, for `Server-Timing` on the purchase's answers.
 * @internal
 */
export class PurchaseTimings implements SpanProcessor {
  /** The step span each open span runs under, by span id. */
  private readonly stepOf = new Map<string, string>();
  private readonly steps = new Map<string, Step>();
  private readonly writes = new Set<Promise<unknown>>();

  /** Where timings are kept: set once Valkey is connected, which is after tracing starts. */
  private kv: RedisClientType | undefined;

  constructor(kv?: RedisClientType) {
    this.kv = kv;
  }

  use(kv: RedisClientType): void {
    this.kv = kv;
  }

  onStart(span: Span): void {
    const id = span.spanContext().spanId;
    const purchaseId = span.attributes["purchase.id"];
    if (span.name.startsWith("purchase.") && typeof purchaseId === "string") {
      this.stepOf.set(id, id);
      this.steps.set(id, { purchaseId, state: "", out: new Map(), internal: new Map(), db: 0 });
      return;
    }
    const parent = span.parentSpanContext?.spanId;
    const step = parent ? this.stepOf.get(parent) : undefined;
    if (step) this.stepOf.set(id, step);
  }

  onEnd(span: ReadableSpan): void {
    const id = span.spanContext().spanId;
    const stepId = this.stepOf.get(id);
    this.stepOf.delete(id);
    const step = stepId ? this.steps.get(stepId) : undefined;
    if (!step) return;
    if (stepId !== id) {
      const host = span.attributes["server.address"];
      // Queries and connections (`pg.*`, `pg-pool.*`) are Postgres time, not outbound calls.
      const postgres = span.name.startsWith("pg.") || span.name.startsWith("pg-pool.");
      if (span.kind === SpanKind.CLIENT && typeof host === "string" && !postgres) {
        step.out.set(host, (step.out.get(host) ?? 0) + ms(span));
      }
      if (postgres) {
        if (span.name.startsWith("pg.query")) step.db += ms(span);
      } else if (span.kind === SpanKind.INTERNAL) {
        step.internal.set(span.name, (step.internal.get(span.name) ?? 0) + ms(span));
      }
      return;
    }
    this.steps.delete(id);
    if (!this.kv) return;
    // The name a step ended with: a countersign that denied is renamed `purchase.DENIED`.
    const state = span.name.slice("purchase.".length);
    const k = key(step.purchaseId);
    const write = this.kv
      .multi()
      .hSet(k, { [`step.${state}`]: ms(span).toFixed(1), [`db.${state}`]: step.db.toFixed(1) })
      .expire(k, TTL_S);
    for (const [host, dur] of step.out) write.hIncrByFloat(k, `out.${host}`, dur);
    for (const [name, dur] of step.internal) write.hIncrByFloat(k, `int.${name}`, dur);
    const done = write.exec().catch(() => {});
    this.writes.add(done);
    void done.finally(() => this.writes.delete(done));
  }

  async forceFlush(): Promise<void> {
    await Promise.all([...this.writes]);
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
  }
}

/** The API's processor, when tracing runs with it (see `telemetry.ts`). */
export const timings = new PurchaseTimings();
