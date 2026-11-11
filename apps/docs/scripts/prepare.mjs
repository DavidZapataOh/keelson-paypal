import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const get = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res;
};
const status = await (await get("https://api.keelson.finance/status")).json();
const checkpoint = (
  await (await get("https://log.keelson.finance/alibi/2026-1/checkpoint")).text()
).split("\n");
const live = {
  fetchedAt: new Date().toISOString(),
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
mkdirSync(fileURLToPath(new URL("../src/data", import.meta.url)), { recursive: true });
writeFileSync(
  fileURLToPath(new URL("../src/data/live.json", import.meta.url)),
  `${JSON.stringify(live, null, 2)}\n`,
);
