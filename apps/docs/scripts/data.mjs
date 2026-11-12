import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repo = (p) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const pub = (p) => fileURLToPath(new URL(`../public/${p}`, import.meta.url));

const yaml = readFileSync(repo("openapi/keelson.yaml"), "utf8");
writeFileSync(pub("openapi.yaml"), yaml);
writeFileSync(pub("openapi.json"), `${JSON.stringify(parse(yaml), null, 2)}\n`);

mkdirSync(pub("samples"), { recursive: true });
for (const id of ["01M6ZWZJHWRRHQEYNJAT7NMSV8", "01M6ZX07MFWDDDW4199FDJHWEG"]) {
  copyFileSync(repo(`packages/alibi/test/fixtures/${id}.alibi`), pub(`samples/${id}.alibi`));
}

// Live values shown on the site are read from production at build time, never written by hand.
const API = process.env.DOCS_API ?? "https://api.keelson.finance";
const LOG = process.env.DOCS_LOG ?? "https://log.keelson.finance";
const DATA = process.env.DOCS_DATA_DIR ?? fileURLToPath(new URL("../src/data", import.meta.url));
const RETRY_MS = Number(process.env.DOCS_RETRY_MS ?? 3_000);

/** Production can blink; three tries a few seconds apart before giving up. */
async function retry(what, attempt) {
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (i === 3) throw new Error(`${what}: ${err.message}`);
      await new Promise((wait) => setTimeout(wait, RETRY_MS * i));
    }
  }
}
const request = (url, init = {}) =>
  retry(`${init.method ?? "GET"} ${url}`, async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000), ...init });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    return res;
  });

// Live values and response examples are read from production when the site is built. Without
// production, the site says they are unavailable; the deployed build (DOCS_REQUIRE_LIVE=1) fails
// instead, so the previous deploy stays up.
let live = { available: false };
let captured = { capturedAt: null, examples: {} };
try {
  const status = await (await request(`${API}/status`)).json();
  const checkpoint = (await (await request(`${LOG}/alibi/2026-1/checkpoint`)).text()).split("\n");
  const fixture = repo("packages/alibi/test/fixtures/01M6ZWZJHWRRHQEYNJAT7NMSV8.alibi");
  const json = async (path, init) => (await request(`${API}${path}`, init)).json();
  captured = {
    capturedAt: new Date().toISOString(),
    examples: {
      "GET /status": status,
      "GET /v1/live-purchases": await json("/v1/live-purchases"),
      "GET /v1/log/bonds": await json("/v1/log/bonds"),
      "POST /v1/alibis/verify": await json("/v1/alibis/verify", {
        method: "POST",
        headers: {
          "content-type": "application/vnd.keelson.alibi.v1+json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: readFileSync(fixture),
      }),
      "GET /v1/alibis/{id}/receipt": await json("/v1/alibis/01M6ZWZJHWRRHQEYNJAT7NMSV8/receipt"),
    },
  };
  live = {
    available: true,
    fetchedAt: captured.capturedAt,
    status: status.status,
    teeA: status.dependencies.teeA,
    teeB: status.dependencies.teeB,
    paypal: status.dependencies.paypal.environment,
    log: {
      origin: checkpoint[0],
      size: Number(checkpoint[1]),
      root: checkpoint[2],
      witnesses: checkpoint.filter((l) => l.startsWith("— witness-")).length,
    },
  };
} catch (err) {
  if (process.env.DOCS_REQUIRE_LIVE === "1") throw err;
  console.warn(`production is unreachable; building without live values (${err.message})`);
}
mkdirSync(DATA, { recursive: true });
writeFileSync(join(DATA, "live.json"), `${JSON.stringify(live, null, 2)}\n`);
writeFileSync(join(DATA, "examples.json"), `${JSON.stringify(captured, null, 2)}\n`);
