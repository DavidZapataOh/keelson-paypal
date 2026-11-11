#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fetchAndVerify, type Report, verifyAlibi } from "./index.ts";

const USAGE = `Usage: keelson-verify [--chain] [--rpc <url>] [--json] <file | - | purchase id>

Verifies a Keelson Alibi on this machine. Exits 0 when verified, 1 when it fails, 2 when
incomplete.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    chain: { type: "boolean", default: false },
    rpc: { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
const [target] = positionals;
if (values.help || !target) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}

const chain = values.rpc ? { rpcUrl: values.rpc } : values.chain;
/** The Alibi on stdin: as issued, as JSON text or as base64. */
async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

let report: Report;
try {
  report =
    target === "-"
      ? await verifyAlibi(await stdin(), { chain })
      : /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(target)
        ? await fetchAndVerify(target, { chain })
        : await verifyAlibi(new Uint8Array(await readFile(target)), { chain });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
if (values.json) console.log(JSON.stringify(report));
else {
  console.log(`${report.verdict}  (${Math.round(report.ms)} ms)`);
  for (const c of report.checks) {
    console.log(`  ${c.status.padEnd(7)} ${c.id}${c.reason ? `  ${c.reason}` : ""}`);
  }
}
process.exitCode = report.verdict === "failed" ? 1 : report.verdict === "incomplete" ? 2 : 0;
