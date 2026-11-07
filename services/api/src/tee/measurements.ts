import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import { type NitroPcrs, nitroMeasurement } from "./attest.ts";

const tee = new URL("../../../../engine/tee/", import.meta.url);
const read = (path: string): Record<string, string> =>
  JSON.parse(readFileSync(new URL(path, tee), "utf8")) as Record<string, string>;

interface Measurements {
  /** The image digest both legs run, as the 32 bytes `engineBuildId` carries. */
  engineBuildId: Hex;
  /** The image digest, `sha256:<hex>`. */
  digest: string;
  tdx: string[];
  nitro: string[];
}

/** The measurements the published deployment files allow. */
export function loadMeasurements(): Measurements {
  const eif = read("nitro/eif.json") as { digest: string; pcr0: Hex; pcr1: Hex; pcr2: Hex };
  const phala = read("phala/measurement.json") as { measurement: string };
  const pcr = (value: string): Hex => (value.startsWith("0x") ? value : `0x${value}`) as Hex;
  return {
    engineBuildId: `0x${eif.digest.replace(/^sha256:/, "")}`,
    digest: eif.digest,
    tdx: [phala.measurement],
    nitro: [
      nitroMeasurement({
        pcrs: { 0: pcr(eif.pcr0), 1: pcr(eif.pcr1), 2: pcr(eif.pcr2) } as NitroPcrs,
      }),
    ],
  };
}
