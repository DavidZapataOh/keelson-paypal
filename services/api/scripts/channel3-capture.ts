/**
 * Captures one real lookup per SKU in `channel3-skus.json` as a test fixture. Each lookup costs
 * one Channel3 credit. Run by hand: `node scripts/channel3-capture.ts [url ...]`; with URLs, only
 * those SKUs are captured again.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createChannel3, LOOKUP_REQUEST } from "../src/channel3/client.ts";

const apiKey = process.env.CHANNEL3_API_KEY;
if (!apiKey) throw new Error("CHANNEL3_API_KEY is not set");

const skus = JSON.parse(
  readFileSync(new URL("../channel3-skus.json", import.meta.url), "utf8"),
) as {
  url: string;
}[];
const out = new URL("../../../packages/core/test/fixtures/channel3/", import.meta.url);
mkdirSync(out, { recursive: true });

const only = process.argv.slice(2);
const { lookup } = createChannel3(apiKey);
for (const { url } of skus.filter((s) => only.length === 0 || only.includes(s.url))) {
  const res = await lookup(url);
  const name = new URL(url).hostname.replace(/^www\./, "").replace(/\./g, "-");
  const fixture = {
    captured_at: new Date(res.receivedAtMs).toISOString(),
    url,
    request: LOOKUP_REQUEST,
    http_status: res.status,
    body_b64: Buffer.from(res.raw).toString("base64"),
  };
  writeFileSync(new URL(`${name}.json`, out), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`${res.status} ${res.error ?? "ok"} ${url}`);
}
