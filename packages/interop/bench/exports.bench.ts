/** Times `exportAll` (local issuer) and `verifyExport` over one v2 statement: p50 and p95 of 200 runs. */
import { exportJWK, generateKeyPair } from "jose";
import { exportAll } from "../src/export.ts";
import { ed25519Signer } from "../src/tap.ts";
import { verifyExport } from "../src/verify.ts";
import { ALLOW_PAYPAL, alibi, factsFor, NOW, testAgent, testIssuer } from "../test/fixtures.ts";
import { RECEIPT_KEYS, v2Ref } from "../test/v2.ts";

const RUNS = 200;
const ref = v2Ref("allow-2of2");
const issuer = await testIssuer(ALLOW_PAYPAL);
const agent = await testAgent();
const { privateKey } = await generateKeyPair("Ed25519", { extractable: true });
const k = { issuer, agent, agentHttp: await ed25519Signer(await exportJWK(privateKey)) };
const f = factsFor(ALLOW_PAYPAL, agent);
const o = { now: NOW, bundle: alibi(ALLOW_PAYPAL) };

const pct = (xs: number[], p: number) =>
  xs.toSorted((a, b) => a - b)[Math.ceil((p / 100) * xs.length) - 1] as number;
async function time(label: string, fn: () => Promise<unknown>) {
  const xs: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    await fn();
    xs.push(performance.now() - t);
  }
  console.log(
    `${label}: p50 ${pct(xs, 50).toFixed(1)} ms, p95 ${pct(xs, 95).toFixed(1)} ms (${RUNS} runs)`,
  );
}

const all = await exportAll(f, ref, k, o);
await time("exportAll (5 formats)", () => exportAll(f, ref, k, o));
for (const [format, x] of Object.entries(all)) {
  await time(`verifyExport ${format}`, () =>
    verifyExport(x, { now: NOW, issuerKeys: [issuer.jwk], receiptKeys: RECEIPT_KEYS }),
  );
}
