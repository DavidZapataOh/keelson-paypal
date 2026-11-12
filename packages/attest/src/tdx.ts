import "@abraham/reflection";
import { PemConverter, X509Certificate, X509Crl } from "@peculiar/x509";
import { type Collateral, verify } from "@phala/dcap-qvl";
import { bytesToHex, type Hex, hexToBytes, hexToString } from "viem";
import { AttestError } from "./errors.ts";
import { type DstackEvent, replayRtmr3, runtimePayload } from "./eventlog.ts";
import { ppidOf } from "./policy.ts";
import { intersect, type Validity } from "./validity.ts";

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
  validity: Validity;
  /** The TD's own configuration, as the quote states it (hex of the quote's bytes). */
  tdAttributes: Hex;
  xfam: Hex;
  mrConfigId: Hex;
  mrOwner: Hex;
  mrOwnerConfig: Hex;
  /** The platform's PPID, from the PCK certificate the quote carries. */
  ppid: Hex;
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

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

function crl(value: Collateral["root_ca_crl"]): X509Crl {
  const der = typeof value === "string" ? hexToBytes(`0x${value}`) : Uint8Array.from(value);
  return new X509Crl(der as Uint8Array<ArrayBuffer>);
}

/**
 * The times at which every dated item DCAP verification checks is current: TCB info and QE
 * identity (`issueDate` to `nextUpdate`), both CRLs (`thisUpdate` to `nextUpdate`) and every
 * certificate of the collateral's chains and of the PCK chain the quote carries.
 */
function collateralValidity(
  quote: Uint8Array,
  c: Collateral & { pck_certificate_chain?: string },
): Validity {
  const bounds: [Date, Date][] = [];
  for (const json of [c.tcb_info, c.qe_identity]) {
    const { issueDate, nextUpdate } = JSON.parse(json) as { issueDate: string; nextUpdate: string };
    bounds.push([new Date(issueDate), new Date(nextUpdate)]);
  }
  for (const list of [crl(c.root_ca_crl), crl(c.pck_crl)]) {
    if (!list.nextUpdate) throw new AttestError("cert_chain", "a CRL has no nextUpdate");
    bounds.push([list.thisUpdate, list.nextUpdate]);
  }
  const chains = [
    c.pck_crl_issuer_chain,
    c.tcb_info_issuer_chain,
    c.qe_identity_issuer_chain,
    c.pck_certificate_chain ?? "",
    new TextDecoder("latin1").decode(quote),
  ];
  for (const pem of chains.flatMap((text) => text.match(PEM) ?? [])) {
    for (const der of PemConverter.decode(pem)) {
      const cert = new X509Certificate(der);
      bounds.push([cert.notBefore, cert.notAfter]);
    }
  }
  return intersect(bounds);
}

/** The PPID of the PCK certificate that leads the quote's certification chain. */
function quotePpid(quote: Uint8Array): Hex {
  const pem = new TextDecoder("latin1").decode(quote).match(PEM)?.[0];
  const der = pem ? PemConverter.decode(pem)[0] : undefined;
  const ext = der ? new X509Certificate(der).getExtension("1.2.840.113741.1.13.1") : null;
  if (!ext) throw new AttestError("cert_chain", "the quote carries no PCK certificate");
  return bytesToHex(ppidOf(new Uint8Array(ext.value)));
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
    validity: collateralValidity(att.quote, att.collateral),
    tdAttributes: bytesToHex(td.tdAttributes),
    xfam: bytesToHex(td.xfam),
    mrConfigId: bytesToHex(td.mrConfigId),
    mrOwner: bytesToHex(td.mrOwner),
    mrOwnerConfig: bytesToHex(td.mrOwnerConfig),
    ppid: quotePpid(att.quote),
  };
}
