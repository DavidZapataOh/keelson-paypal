/**
 * Captures the live legs' attestations into the vectors the contract tests read.
 *
 *   node contracts/test/vectors/capture.ts
 *
 * Writes `tdx-events.json`, leg A's quote registers and RTMR3 events, and `nitro-attestation.json`,
 * leg B's document split for Base's `nitro-validator` with the P-384 inverse hints of every certificate
 * and of the document, each with the measurement the API verified for it; and
 * `nitro-attestation-expired.json`, the same split of the older captured document in
 * `packages/attest/test/evidence`, whose leaf certificate has expired.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { prepareHintedAttestationCalls } = require(
  "../../../services/api/src/chain/vendor/nitro-validator/hinted_attestation_calls.js",
) as {
  prepareHintedAttestationCalls: (attestation: Uint8Array) => {
    cold: { kind: string; args: Record<string, string> }[];
  };
};

const API = process.env.KEELSON_API_URL ?? "https://api.keelson.finance";

interface DstackEvent {
  imr: number;
  event_type: number;
  event: string;
  event_payload: string;
}

interface Leg {
  tee: "tdx" | "nitro";
  signer: string;
  measurement: string;
  attestation: {
    quote?: string;
    eventLog?: DstackEvent[];
    document?: string;
    binding: Record<string, unknown>;
    block: { number: number; hash: string };
  };
}

/** Offsets in a v4 quote: the 48-byte header, then the TD10 report body (Intel TDX DCAP API, A.3). */
const TD10 = { mrtd: 184, rtmr0: 376, reportData: 568 } as const;

const hex = (bytes: Buffer) => `0x${bytes.toString("hex")}`;

const response = await fetch(`${API}/v1/tee/attestations`);
if (!response.ok) throw new Error(`${API}/v1/tee/attestations: ${response.status}`);
const { legs } = (await response.json()) as { legs: Leg[] };
const tdx = legs.find((leg) => leg.tee === "tdx");
if (!tdx?.attestation.quote || !tdx.attestation.eventLog) throw new Error("no tdx leg");

const quote = Buffer.from(tdx.attestation.quote, "hex");
const register = (offset: number, length = 48) => hex(quote.subarray(offset, offset + length));
const vectors = {
  capturedAt: new Date().toISOString(),
  source: `${API}/v1/tee/attestations`,
  signer: tdx.signer,
  measurement: `0x${tdx.measurement.replace("tdx:", "")}`,
  mrtd: register(TD10.mrtd),
  rtmr0: register(TD10.rtmr0),
  rtmr1: register(TD10.rtmr0 + 48),
  rtmr2: register(TD10.rtmr0 + 96),
  rtmr3: register(TD10.rtmr0 + 144),
  reportData: register(TD10.reportData, 64),
  quote: hex(quote),
  events: tdx.attestation.eventLog
    .filter((e) => e.imr === 3)
    .map((e) => ({ name: e.event, payload: `0x${e.event_payload}`, eventType: e.event_type })),
};
const out = join(import.meta.dirname, "tdx-events.json");
writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`${out}: ${vectors.events.length} events, ${vectors.measurement}`);

/** The document split into the calls Base's `nitro-validator` takes, with their hints. */
function split(documentBase64: string) {
  const plan = prepareHintedAttestationCalls(Buffer.from(documentBase64, "base64"));
  const certs = plan.cold.filter((call) => call.kind !== "validate_attestation");
  const document = plan.cold.find((call) => call.kind === "validate_attestation");
  if (!document) throw new Error("no document call");
  return {
    certs: certs.map((call) => ({
      leaf: call.kind === "cache_leaf",
      cert: call.args.cert,
      parentCertHash: call.args.parentCertHash,
      hints: call.args.signatureHints,
    })),
    attestationTbs: document.args.attestationTbs,
    signature: document.args.signature,
    attestationHints: document.args.attestationHints,
  };
}

const nitro = legs.find((leg) => leg.tee === "nitro");
if (!nitro?.attestation.document) throw new Error("no nitro leg");
const nitroVectors = {
  capturedAt: vectors.capturedAt,
  source: vectors.source,
  signer: nitro.signer,
  measurement: `0x${nitro.measurement.replace("nitro:", "")}`,
  binding: nitro.attestation.binding,
  block: nitro.attestation.block,
  ...split(nitro.attestation.document),
};
const nitroOut = join(import.meta.dirname, "nitro-attestation.json");
writeFileSync(nitroOut, `${JSON.stringify(nitroVectors, null, 2)}\n`);
console.log(`${nitroOut}: ${nitroVectors.certs.length} certificates, ${nitroVectors.measurement}`);

const evidence = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../packages/attest/test/evidence/nitro-leg-b.json"), "utf8"),
) as { capturedAt: string; attestation: { document: string } };
const expiredOut = join(import.meta.dirname, "nitro-attestation-expired.json");
writeFileSync(
  expiredOut,
  `${JSON.stringify({ capturedAt: evidence.capturedAt, ...split(evidence.attestation.document) }, null, 2)}\n`,
);
console.log(`${expiredOut}: captured ${evidence.capturedAt}`);
