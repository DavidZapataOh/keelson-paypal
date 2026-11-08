/**
 * Captures the live legs' attestations into the vectors the contract tests read.
 *
 *   node contracts/test/vectors/capture.ts
 *
 * Writes `tdx-events.json`: leg A's quote registers and RTMR3 events, with the measurement the API
 * verified for them.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

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
  attestation: { quote?: string; eventLog?: DstackEvent[]; block: { number: number; hash: string } };
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
  events: tdx.attestation.eventLog
    .filter((e) => e.imr === 3)
    .map((e) => ({ name: e.event, payload: `0x${e.event_payload}`, eventType: e.event_type })),
};
const out = join(import.meta.dirname, "tdx-events.json");
writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`${out}: ${vectors.events.length} events, ${vectors.measurement}`);
