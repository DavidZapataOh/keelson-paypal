/**
 * Samples how far the enclave's clock is from this machine's, and from leg A's.
 *
 *   node clock-drift.ts --b <url> [--a <url>] [--every 300] [--for 86400] [--log drift.jsonl]
 *   node clock-drift.ts --summary <drift.jsonl>
 *
 * Every `--every` seconds it reads `now_ms` from `/v1/health` of each leg and compares it with the
 * midpoint of this machine's clock around the request, so run it on a chrony-synced host. A line of
 * JSON per sample goes to the log; `--summary` prints the largest absolute drifts.
 */
import { appendFile, readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

interface Sample {
  at: string;
  /** Local clock minus the leg's clock, in milliseconds, and the request's round trip. */
  b?: { drift_ms: number; rtt_ms: number } | { error: string };
  a?: { drift_ms: number; rtt_ms: number } | { error: string };
  /** The drift between the legs: leg B's clock minus leg A's. */
  b_minus_a_ms?: number;
}

async function drift(url: string) {
  const before = Date.now();
  const response = await fetch(new URL("/v1/health", url), { signal: AbortSignal.timeout(10_000) });
  const after = Date.now();
  if (!response.ok) throw new Error(`health answered ${response.status}`);
  const { now_ms } = (await response.json()) as { now_ms: number };
  return { drift_ms: (before + after) / 2 - now_ms, rtt_ms: after - before };
}

async function sample(a: string | undefined, b: string): Promise<Sample> {
  const measure = (url: string) => drift(url).catch((error: unknown) => ({ error: String(error) }));
  const [onB, onA] = await Promise.all([measure(b), a ? measure(a) : undefined]);
  const out: Sample = { at: new Date().toISOString(), b: onB };
  if (onA) out.a = onA;
  if ("drift_ms" in onB && onA && "drift_ms" in onA) out.b_minus_a_ms = onA.drift_ms - onB.drift_ms;
  return out;
}

async function summary(path: string) {
  const samples = (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Sample);
  const max = (values: number[]) => Math.max(0, ...values.map(Math.abs));
  const drifts = (leg: "a" | "b") =>
    samples.flatMap((s) => {
      const d = s[leg];
      return d && "drift_ms" in d ? [d.drift_ms] : [];
    });
  console.log(
    JSON.stringify({
      samples: samples.length,
      errors: samples.filter((s) => [s.a, s.b].some((d) => d && "error" in d)).length,
      first: samples[0]?.at,
      last: samples.at(-1)?.at,
      max_abs_b_ms: max(drifts("b")),
      max_abs_a_ms: max(drifts("a")),
      max_abs_b_minus_a_ms: max(
        samples.flatMap((s) => (s.b_minus_a_ms === undefined ? [] : [s.b_minus_a_ms])),
      ),
    }),
  );
}

const summaryPath = flag("summary");
if (summaryPath) {
  await summary(summaryPath);
  process.exit(0);
}

const b = flag("b");
if (!b) {
  console.error(
    "usage: clock-drift.ts --b <url> [--a <url>] [--every 300] [--for 86400] [--log drift.jsonl]",
  );
  process.exit(1);
}
const a = flag("a");
const everyMs = Number(flag("every") ?? 300) * 1000;
const untilMs = Date.now() + Number(flag("for") ?? 86_400) * 1000;
const log = flag("log") ?? "drift.jsonl";

for (let next = Date.now(); next <= untilMs; next += everyMs) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, next - Date.now())));
  await appendFile(log, `${JSON.stringify(await sample(a, b))}\n`);
}
