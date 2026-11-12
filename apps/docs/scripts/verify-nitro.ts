/**
 * Verifies the AWS Nitro attestation document leg B serves, read from stdin as its JSON answer,
 * against AWS's Nitro root as of when the enclave produced it (the leaf certificate is short-lived),
 * and prints the enclave's measurement and the document's age.
 *
 *   curl -s https://tee-b.keelson.finance/v1/attestation | node scripts/verify-nitro.ts
 */
import { readFileSync } from "node:fs";
import { nitroMeasurement, nitroTimestamp, verifyNitro } from "@keelson/attest";

const { document } = JSON.parse(readFileSync(0, "utf8")) as { document: string };
const bytes = Buffer.from(document, "base64");
const producedAt = nitroTimestamp(bytes);
const result = await verifyNitro(bytes, { now: producedAt });
console.error(
  `attested ${producedAt.toISOString()}, ${Math.round((Date.now() - producedAt.getTime()) / 3_600_000)} h ago`,
);
console.log(nitroMeasurement(result));
