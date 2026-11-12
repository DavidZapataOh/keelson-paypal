export interface Stats {
  p50: number;
  p95: number;
  max: number;
  count: number;
}

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

const GROUPS = { step: "steps", out: "outbound", int: "internal", db: "db" } as const;

/**
 * The per-step waterfall of purchases from their `Server-Timing` (one record per purchase, as
 * `parseServerTiming` reads it): each `purchase.<state>` step, the outbound calls made inside
 * the steps by host, the work inside them, and each step's Postgres time.
 */
export function waterfall(purchases: Record<string, number>[]) {
  const groups = { steps: {}, outbound: {}, internal: {}, db: {} } as Record<
    (typeof GROUPS)[keyof typeof GROUPS],
    Record<string, number[]>
  >;
  for (const timings of purchases) {
    for (const [metric, dur] of Object.entries(timings)) {
      const dot = metric.indexOf(".");
      const group = GROUPS[metric.slice(0, dot) as keyof typeof GROUPS];
      if (!group) continue;
      const name =
        group === "steps" || group === "db"
          ? `purchase.${metric.slice(dot + 1)}`
          : metric.slice(dot + 1);
      groups[group][name] = [...(groups[group][name] ?? []), dur];
    }
  }
  const record = (m: Record<string, number[]>) =>
    Object.fromEntries(
      Object.entries(m)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stats(v)]),
    );
  return {
    steps: record(groups.steps),
    outbound: record(groups.outbound),
    internal: record(groups.internal),
    db: record(groups.db),
  };
}
