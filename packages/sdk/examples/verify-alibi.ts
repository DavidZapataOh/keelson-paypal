// Verifies a purchase's Alibi on this machine, with the same checks as verify.keelson.finance.
//
//   node examples/verify-alibi.ts <purchaseId>          offline: nothing but the download
//   node examples/verify-alibi.ts <purchaseId> --chain  also reads the anchor on Arbitrum
import { fetchAlibi, Keelson, verifyAlibi } from "@keelson/sdk";

const [purchaseId, flag] = process.argv.slice(2);
if (!purchaseId) throw new Error("usage: verify-alibi.ts <purchaseId> [--chain]");

const alibi = await fetchAlibi(new Keelson(), purchaseId);
const report = await verifyAlibi(alibi, flag === "--chain" ? { chain: true } : {});
for (const check of report.checks) {
  console.log(`${check.status.padEnd(12)} ${check.id}${check.reason ? `  ${check.reason}` : ""}`);
}
console.log(report.verdict);
