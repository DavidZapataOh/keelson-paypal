import { loadMeasurements } from "./measurements.ts";

/** The policy engine build and the TEE measurements a compiled mandate names. */
export async function engineSource(): Promise<{
  engine: "keelson-engine";
  version: string;
  measurements: string[];
}> {
  const m = loadMeasurements();
  return {
    engine: "keelson-engine",
    version: m.digest.replace("sha256:", "").slice(0, 12),
    measurements: [...m.tdx, ...m.nitro],
  };
}
