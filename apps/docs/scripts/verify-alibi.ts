/**
 * Verifies an Alibi on this machine with the reference verifier, against the trust roots pinned in
 * its code and a public Arbitrum RPC. No Keelson server is involved.
 *
 *   node scripts/verify-alibi.ts <file.alibi>
 */
import { readFileSync } from "node:fs";
import { decodeAlibi } from "@keelson/alibi";
import { createChainReader, verifyAlibi } from "@keelson/alibi/verify";

const file = process.argv[2];
if (!file) throw new Error("usage: verify-alibi.ts <file.alibi>");
const report = await verifyAlibi(decodeAlibi(new Uint8Array(readFileSync(file))), {
  chain: createChainReader(),
});
console.log(`${report.verdict} ${report.mode}`);
for (const c of report.checks) console.log(`${c.id} ${c.status}`);
