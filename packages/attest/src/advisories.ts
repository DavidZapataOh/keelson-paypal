/**
 * Intel advisories under which a `SWHardeningNeeded` TCB is accepted, each with the reason it is
 * safe for a CVM that runs no SGX enclave and trusts no host-supplied ACPI.
 *
 * An advisory is added only after reading Intel's page for it and confirming that the dstack OS
 * image applies its mitigation. Intel's TCB info for leg A's FMSPC (`20A06F000000`, evaluation data
 * number 20) has no `SWHardeningNeeded` level, so none is accepted.
 */
export const ACCEPTED_ADVISORIES: Readonly<Record<string, string>> = Object.freeze({});

interface TcbLevel {
  tcbStatus: string;
  advisoryIDs?: string[];
}

interface TcbInfo {
  tcbLevels: TcbLevel[];
  tdxModuleIdentities?: { tcbLevels: TcbLevel[] }[];
}

/**
 * Advisories at any `SWHardeningNeeded` level of Intel's TCB info, for the platform or a TDX
 * module, that `ACCEPTED_ADVISORIES` does not hold. Takes the bare TCB info or Intel's response.
 */
export function unreviewedAdvisories(json: string): string[] {
  const parsed = JSON.parse(json) as TcbInfo | { tcbInfo: TcbInfo };
  const info = "tcbInfo" in parsed ? parsed.tcbInfo : parsed;
  const levels = [
    ...info.tcbLevels,
    ...(info.tdxModuleIdentities ?? []).flatMap((m) => m.tcbLevels),
  ];
  const ids = levels
    .filter((level) => level.tcbStatus === "SWHardeningNeeded")
    .flatMap((level) => level.advisoryIDs ?? [])
    .filter((id) => !Object.hasOwn(ACCEPTED_ADVISORIES, id));
  return [...new Set(ids)].sort();
}
