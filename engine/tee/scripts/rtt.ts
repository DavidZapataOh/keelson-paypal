/**
 * Round-trip time to a deployed engine, measured from where this runs.
 *
 *   node scripts/rtt.ts <url> [requests] [path]
 *   node scripts/rtt.ts --leg a|b [requests] [path]
 *
 * `--leg` takes the URL from `TEE_A_URL` or `TEE_B_URL`.
 *
 * It sends `requests` (200 by default) sequential GETs of `path` (`/v1/health` by default) over
 * one connection, after a warm-up, and prints the percentiles in milliseconds as JSON.
 */
const argv = process.argv.slice(2);
const leg = argv[0] === "--leg" ? argv.splice(0, 2)[1] : undefined;
const [given, count = "200", path = "/v1/health"] = argv;
const url = leg ? process.env[`TEE_${leg.toUpperCase()}_URL`] : given;
if (!url) {
  console.error("usage: rtt.ts <url> [requests] [path] | --leg a|b [requests] [path]");
  process.exit(1);
}

const target = new URL(path, url);

async function once() {
  const started = performance.now();
  const response = await fetch(target);
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`${target} answered ${response.status}`);
  return performance.now() - started;
}

for (let i = 0; i < 10; i++) await once();

const samples: number[] = [];
for (let i = 0; i < Number(count); i++) samples.push(await once());
samples.sort((a, b) => a - b);

const at = (p: number) =>
  Number((samples[Math.min(samples.length - 1, Math.floor(samples.length * p))] ?? 0).toFixed(1));
console.log(
  JSON.stringify({
    url: target.href,
    requests: samples.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: at(1),
  }),
);
