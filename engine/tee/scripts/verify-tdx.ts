/**
 * Verifies the TDX quote that a deployed leg A serves, without trusting the verifier service:
 * the quote against Intel's collateral, RTMR3 against the replayed event log, and the
 * `compose-hash` event against the app-compose the CVM was deployed with.
 *
 *   node scripts/verify-tdx.ts <leg-a-url> <app-compose.json>
 *
 * `<app-compose.json>` is the CVM's compose file as `GET /cvms/{id}/compose_file` returns it.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getComposeHash } from "@phala/cloud";
import { getCollateral, PHALA_PCCS_URL, Quote, verify } from "@phala/dcap-qvl";

interface RuntimeEvent {
  imr: number;
  event_type: number;
  digest: string;
  event: string;
  event_payload: string;
}

interface Attestation {
  tee: string;
  quote: string;
  event_log: RuntimeEvent[];
  app_id: string;
  compose_hash: string;
  dstack_version: string;
}

/** dstack's event type for the runtime events that extend RTMR3. */
const RUNTIME_EVENT = 0x08000001;
/** Statuses that are accepted; the second is recorded with its advisories. */
const ACCEPTED = ["UpToDate", "SWHardeningNeeded"];

const sha384 = (...parts: Uint8Array[]) => {
  const hash = createHash("sha384");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

/** The digest dstack computes for a runtime event: SHA-384 of its type, name and payload. */
function eventDigest(e: RuntimeEvent) {
  const payload = Buffer.from(e.event_payload, "hex");
  const type = Buffer.alloc(4);
  type.writeUInt32LE(RUNTIME_EVENT);
  return sha384(type, Buffer.from(`:${e.event}:`), payload);
}

/** Replays the runtime events into RTMR3, checking each digest against its name and payload. */
function replayRtmr3(log: RuntimeEvent[]) {
  let rtmr = Buffer.alloc(48);
  for (const e of log.filter((e) => e.imr === 3)) {
    if (e.event_type !== RUNTIME_EVENT) fail(`event ${e.event} has type ${e.event_type}`);
    const digest = Buffer.from(e.digest, "hex");
    if (!digest.equals(eventDigest(e))) fail(`event ${e.event} does not match its digest`);
    rtmr = sha384(rtmr, digest);
  }
  return rtmr;
}

function payload(log: RuntimeEvent[], name: string) {
  const e = log.find((e) => e.imr === 3 && e.event === name);
  if (!e) fail(`no ${name} event`);
  return e.event_payload;
}

const [url, composePath] = process.argv.slice(2);
if (!url || !composePath) fail("usage: verify-tdx.ts <leg-a-url> <app-compose.json>");

const response = await fetch(new URL("/v1/attestation", url));
if (!response.ok) fail(`GET /v1/attestation answered ${response.status}`);
const attestation = (await response.json()) as Attestation;
if (attestation.tee !== "tdx") fail(`tee is ${attestation.tee}`);

const quote = Buffer.from(attestation.quote, "hex");
const collateral = await getCollateral(PHALA_PCCS_URL, quote);
const verified = verify(quote, collateral, Date.now() / 1000);
if (!ACCEPTED.includes(verified.status)) fail(`tcb status ${verified.status}`);
console.log(`tcb ${verified.status} advisories [${verified.advisory_ids.join(", ")}]`);

const td = Quote.parse(quote).report.asTd10();
if (!td) fail("the quote is not a TDX quote");
const replayed = replayRtmr3(attestation.event_log);
if (hex(td.rtMr3) !== hex(replayed))
  fail(`rtmr3 ${hex(td.rtMr3)} but the log replays to ${hex(replayed)}`);
console.log(`rtmr3 ${hex(replayed)}`);

const compose = getComposeHash(JSON.parse(await readFile(composePath, "utf8")));
if (payload(attestation.event_log, "compose-hash") !== compose) {
  fail(
    `compose-hash is ${payload(attestation.event_log, "compose-hash")}, the deployed file is ${compose}`,
  );
}
if (attestation.compose_hash !== compose) fail("compose_hash differs from the deployed file");
if (payload(attestation.event_log, "app-id") !== attestation.app_id)
  fail("app_id differs from the log");
const instance = payload(attestation.event_log, "instance-id");
console.log(
  `compose-hash ${compose} app ${attestation.app_id} instance ${instance} dstack ${attestation.dstack_version}`,
);
