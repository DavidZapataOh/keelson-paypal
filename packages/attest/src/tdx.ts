import { type Collateral, verify } from "@phala/dcap-qvl";
import { bytesToHex, type Hex, hexToString } from "viem";
import { AttestError } from "./errors.ts";
import { type DstackEvent, replayRtmr3, runtimePayload } from "./eventlog.ts";

export type { Collateral };

export interface TdxResult {
  tcbStatus: string;
  advisoryIds: string[];
  mrtd: Hex;
  rtmr: [Hex, Hex, Hex, Hex];
  reportData: Hex;
  composeHash: Hex;
  appId: Hex;
  osImageHash: Hex | null;
  keyProvider: string | null;
}

/** `SWHardeningNeeded` passes only when Intel names the advisories, so they can be recorded. */
export function acceptTcbStatus(status: string, advisoryIds: readonly string[]): void {
  if (status === "UpToDate") return;
  if (status === "SWHardeningNeeded" && advisoryIds.length > 0) return;
  throw new AttestError("tcb_status", `the TCB status is ${status}`);
}

/** Maps a failure of the DCAP verifier to the reason a caller can act on. */
function classify(error: Error): AttestError {
  const message = error.message;
  const code = /expired|not yet valid|in the future/i.test(message)
    ? "collateral_expired"
    : /TCB status/.test(message)
      ? "tcb_status"
      : /debug/i.test(message)
        ? "debug_mode"
        : /signature/i.test(message)
          ? "signature"
          : /certificate|CRL/i.test(message)
            ? "cert_chain"
            : "signature";
  return new AttestError(code, message, { cause: error });
}

function required(events: readonly DstackEvent[], name: string): Hex {
  const payload = runtimePayload(events, name);
  if (!payload) throw new AttestError("rtmr3_mismatch", `the event log has no ${name} event`);
  return payload;
}

/**
 * Verifies a TDX quote against Intel collateral at `now`, then replays the event log into RTMR3
 * and requires it to equal the quote's.
 */
export async function verifyTdx(
  att: { quote: Uint8Array; eventLog: readonly DstackEvent[]; collateral: Collateral },
  opts: { now: Date },
): Promise<TdxResult> {
  let verified: ReturnType<typeof verify>;
  try {
    verified = verify(att.quote, att.collateral, opts.now.getTime() / 1000);
  } catch (error) {
    throw classify(error instanceof Error ? error : new Error(String(error)));
  }
  acceptTcbStatus(verified.status, verified.advisory_ids);

  const td = verified.report.asTd10() ?? verified.report.asTd15()?.base;
  if (!td) throw new AttestError("signature", "the quote is not a TDX quote");
  const rtmr = [td.rtMr0, td.rtMr1, td.rtMr2, td.rtMr3].map((r) => bytesToHex(r)) as [
    Hex,
    Hex,
    Hex,
    Hex,
  ];
  const replayed = await replayRtmr3(att.eventLog);
  if (replayed !== rtmr[3]) {
    throw new AttestError("rtmr3_mismatch", `the event log replays to ${replayed}, not ${rtmr[3]}`);
  }

  const provider = runtimePayload(att.eventLog, "key-provider");
  return {
    tcbStatus: verified.status,
    advisoryIds: verified.advisory_ids,
    mrtd: bytesToHex(td.mrTd),
    rtmr,
    reportData: bytesToHex(td.reportData),
    composeHash: required(att.eventLog, "compose-hash"),
    appId: required(att.eventLog, "app-id"),
    osImageHash: runtimePayload(att.eventLog, "os-image-hash"),
    keyProvider: provider ? hexToString(provider) : null,
  };
}
