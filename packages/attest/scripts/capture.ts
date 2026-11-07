/**
 * Captures the attestation a live leg serves, with Intel's collateral for a TDX quote, as test
 * evidence.
 *
 *   node scripts/capture.ts <leg-url> <out.json>
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { getCollateral, PHALA_PCCS_URL } from "@phala/dcap-qvl";

const [url, out] = process.argv.slice(2);
if (!url || !out) throw new Error("usage: capture.ts <leg-url> <out.json>");

const response = await fetch(new URL("/v1/attestation", url));
if (!response.ok) throw new Error(`GET /v1/attestation answered ${response.status}`);
const body = await response.text();
const attestation = JSON.parse(body) as { tee: string; quote?: string };

const evidence: Record<string, unknown> = {
  capturedAt: new Date().toISOString(),
  leg: attestation.tee,
  sha256: createHash("sha256").update(body).digest("hex"),
  attestation,
};
if (attestation.tee === "tdx" && attestation.quote) {
  evidence.collateral = await getCollateral(PHALA_PCCS_URL, Buffer.from(attestation.quote, "hex"));
}
await writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`${attestation.tee} captured at ${evidence.capturedAt} sha256 ${evidence.sha256}`);
