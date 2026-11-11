import { SpanKind } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";

export interface Stats {
  p50: number;
  p95: number;
  max: number;
  count: number;
}

const ms = (s: ReadableSpan) => s.duration[0] * 1_000 + s.duration[1] / 1e6;

export function percentile(xs: number[], q: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
}

export function stats(xs: number[]): Stats {
  const r = (x: number) => Math.round(x);
  return {
    p50: r(percentile(xs, 0.5)),
    p95: r(percentile(xs, 0.95)),
    max: r(Math.max(0, ...xs)),
    count: xs.length,
  };
}

/**
 * The per-step waterfall of the purchases in `spans`, or of purchase `only`: the duration of each
 * `purchase.<state>` span, each outbound call made inside one by host, and the Postgres time each
 * step spends.
 */
export function waterfall(spans: ReadableSpan[], only?: string) {
  const byId = new Map(spans.map((s) => [s.spanContext().spanId, s]));
  /** The purchase step a span runs under, if any. */
  const stepOf = (s: ReadableSpan): ReadableSpan | undefined => {
    for (let p: ReadableSpan | undefined = s; p; ) {
      if (p.name.startsWith("purchase.")) return p;
      const parent: string | undefined = p.parentSpanContext?.spanId;
      p = parent ? byId.get(parent) : undefined;
    }
    return undefined;
  };
  const steps = new Map<string, number[]>();
  const outbound = new Map<string, number[]>();
  const db = new Map<string, Map<string, number>>();
  for (const s of spans) {
    if (only !== undefined && stepOf(s)?.attributes["purchase.id"] !== only) continue;
    if (s.name.startsWith("purchase.")) {
      steps.set(s.name, [...(steps.get(s.name) ?? []), ms(s)]);
      continue;
    }
    const step = stepOf(s);
    if (!step) continue;
    if (s.kind === SpanKind.CLIENT && s.attributes["server.address"]) {
      const host = String(s.attributes["server.address"]);
      outbound.set(host, [...(outbound.get(host) ?? []), ms(s)]);
    }
    if (s.name.startsWith("pg.query")) {
      const per = db.get(step.name) ?? new Map<string, number>();
      const id = step.spanContext().spanId;
      per.set(id, (per.get(id) ?? 0) + ms(s));
      db.set(step.name, per);
    }
  }
  const record = (m: Map<string, number[]>) =>
    Object.fromEntries([...m].sort().map(([k, v]) => [k, stats(v)]));
  return {
    steps: record(steps),
    outbound: record(outbound),
    db: Object.fromEntries([...db].sort().map(([k, v]) => [k, stats([...v.values()])])),
  };
}
