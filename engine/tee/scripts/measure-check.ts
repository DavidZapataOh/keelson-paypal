/**
 * Compares a `measurements.json` with what the live legs attest: each leg's quote or document is
 * verified, its measurement id is recomputed from the verified registers and the event log, and
 * both must equal the file's. Every mismatch is printed before the script exits 1.
 *
 *   TEE_A_URL=… TEE_B_URL=… node scripts/measure-check.ts <measurements.json>
 */
import { readFile } from "node:fs/promises";
import {
  type DstackEvent,
  nitroMeasurement,
  tdxMeasurement,
  verifyNitro,
  verifyTdx,
} from "@keelson/attest";
import { getCollateral } from "@keelson/attest/server";

interface Measurements {
  oci_digest: string;
  tdx: { id: string };
  nitro: { id: string };
}

const [file] = process.argv.slice(2);
const urls = { a: process.env.TEE_A_URL, b: process.env.TEE_B_URL };
if (!file || !urls.a || !urls.b) {
  console.error("usage: TEE_A_URL=… TEE_B_URL=… measure-check.ts <measurements.json>");
  process.exit(2);
}
const expected = JSON.parse(await readFile(file, "utf8")) as Measurements;

interface Attested {
  quote: string;
  event_log: DstackEvent[];
  document: string;
  binding: { engineBuildId: string };
}

async function attestation(url: string): Promise<Attested> {
  const response = await fetch(new URL("/v1/attestation", url));
  if (!response.ok) throw new Error(`GET ${url}/v1/attestation answered ${response.status}`);
  return (await response.json()) as Attested;
}

const failures: string[] = [];
const compare = (leg: string, live: string, file: string, build: string, want: string) => {
  console.log(`${leg}: live ${live}`);
  console.log(`${leg}: file ${file}`);
  if (live !== file)
    failures.push(`${leg} measurement: the leg attests ${live}, the file has ${file}`);
  if (build.toLowerCase() !== `0x${want.replace(/^sha256:/, "")}`) {
    failures.push(`${leg} build id: the leg binds ${build}, the file has ${want}`);
  }
};

const now = new Date();
const a = await attestation(urls.a);
const tdx = await verifyTdx(
  {
    quote: Buffer.from(a.quote, "hex"),
    eventLog: a.event_log,
    collateral: await getCollateral(Buffer.from(a.quote, "hex")),
  },
  { now },
);
compare("tdx", tdxMeasurement(tdx), expected.tdx.id, a.binding.engineBuildId, expected.oci_digest);

const b = await attestation(urls.b);
const nitro = await verifyNitro(Buffer.from(b.document, "base64"), { now });
compare(
  "nitro",
  nitroMeasurement(nitro),
  expected.nitro.id,
  b.binding.engineBuildId,
  expected.oci_digest,
);

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log("both legs match");
