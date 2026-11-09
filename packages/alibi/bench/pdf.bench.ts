/** Times the codec, the offline verifier, the PDF and its extraction over the captured fixtures. */
import { gzipSync } from "node:zlib";
import { decodeAlibi, encodeAlibi } from "../src/codec.ts";
import { extractAlibi } from "../src/extract.ts";
import { qrMetrics, renderAlibiPdf } from "../src/pdf.ts";
import { verifyAlibi } from "../src/verify/index.ts";
import { fixtures } from "../test/fixtures.ts";

const RUNS = Number(process.env.RUNS ?? 50);
const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return (s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] ?? 0).toFixed(1);
};
async function time(fn: () => unknown): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    await fn();
    out.push(performance.now() - t);
  }
  return out;
}

console.log(
  "| fixture | mode | bundle B (gzip) | codec p95 ms | verify p50/p95 ms | pdf p50/p95 ms | pdf KiB | extract p95 ms | QR version / module mm |",
);
console.log("|---|---|---|---|---|---|---|---|---|");
for (const f of fixtures) {
  const codec = await time(() => decodeAlibi(encodeAlibi(f.bundle)));
  const verify = await time(() => verifyAlibi(f.bundle));
  const render = await time(() => renderAlibiPdf(f.bundle));
  const pdf = await renderAlibiPdf(f.bundle);
  const extract = await time(() => extractAlibi(pdf));
  const qr = qrMetrics(f.bundle);
  console.log(
    `| ${f.id} | ${f.mode}${f.anchored ? ", anchored" : ""} | ${f.bytes.length} (${gzipSync(f.bytes).length}) | ${q(codec, 0.95)} | ${q(verify, 0.5)} / ${q(verify, 0.95)} | ${q(render, 0.5)} / ${q(render, 0.95)} | ${(pdf.length / 1024).toFixed(1)} | ${q(extract, 0.95)} | ${qr.version} / ${qr.moduleMm.toFixed(2)} |`,
  );
}
