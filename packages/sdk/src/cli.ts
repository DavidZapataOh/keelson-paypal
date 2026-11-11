#!/usr/bin/env node
// keelson-verify: verifies an Alibi bundle or receipt offline and prints the report as JSON.
//
//   keelson-verify <file | ->            nothing is read from any network
//   keelson-verify --chain [--rpc <url>] <file | ->   also reads the on-chain anchor
//
// Exits 0 when every check passed, 1 when one failed, 2 when the report is incomplete.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { verifyAlibi } from "./verify.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { chain: { type: "boolean" }, rpc: { type: "string" } },
});
const source = positionals[0];
if (!source) {
  console.error("usage: keelson-verify [--chain [--rpc <url>]] <alibi.json | ->");
  process.exit(64);
}
const bytes = new Uint8Array(readFileSync(source === "-" ? 0 : source));
const rpc = values.rpc;
const report = await verifyAlibi(bytes, {
  ...(values.chain ? { chain: rpc ? { rpc: { 421614: rpc, 42161: rpc } } : true } : {}),
});
process.stdout.write(
  `${JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n`,
);
process.exit(report.verdict === "failed" ? 1 : report.verdict === "incomplete" ? 2 : 0);
