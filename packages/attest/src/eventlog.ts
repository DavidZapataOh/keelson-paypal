import { bytesToHex, type Hex, hexToBytes } from "viem";
import { AttestError } from "./errors.ts";

/** One entry of the event log dstack serves next to a TDX quote. */
export interface DstackEvent {
  imr: number;
  event_type: number;
  digest: string;
  event: string;
  event_payload: string;
}

/** The type of the runtime events that dstack extends into RTMR3. */
const RUNTIME_EVENT = 0x08000001;

async function sha384(...parts: Uint8Array[]): Promise<Uint8Array> {
  const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-384", data));
}

const hex = (value: string): Uint8Array => hexToBytes(`0x${value}`);

/** The digest dstack computes for a runtime event: SHA-384 of its type, name and payload. */
async function eventDigest(e: DstackEvent): Promise<Uint8Array> {
  const type = new Uint8Array(4);
  new DataView(type.buffer).setUint32(0, e.event_type, true);
  return sha384(type, new TextEncoder().encode(`:${e.event}:`), hex(e.event_payload));
}

/**
 * Replays the runtime events into RTMR3: every digest is recomputed from the event's name and
 * payload, then extended with SHA-384 from 48 zero bytes.
 */
export async function replayRtmr3(events: readonly DstackEvent[]): Promise<Hex> {
  let rtmr: Uint8Array = new Uint8Array(48);
  for (const e of events.filter((e) => e.imr === 3)) {
    if (e.event_type !== RUNTIME_EVENT) {
      throw new AttestError("rtmr3_mismatch", `event ${e.event} has type ${e.event_type}`);
    }
    const digest = await eventDigest(e);
    if (bytesToHex(digest) !== `0x${e.digest.toLowerCase()}`) {
      throw new AttestError("rtmr3_mismatch", `event ${e.event} does not match its digest`);
    }
    rtmr = await sha384(rtmr, digest);
  }
  return bytesToHex(rtmr);
}

/** The payload of the named RTMR3 event as a hex string, or `null` when the log has none. */
export function runtimePayload(events: readonly DstackEvent[], name: string): Hex | null {
  const e = events.find((e) => e.imr === 3 && e.event === name);
  return e ? (`0x${e.event_payload.toLowerCase()}` as Hex) : null;
}
