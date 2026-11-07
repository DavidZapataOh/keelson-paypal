import { readFileSync } from "node:fs";
import type { Hex } from "viem";

const file = new URL("../../../../engine/tee/measurements.json", import.meta.url);

interface Measurements {
  /** The image digest both legs run, as the 32 bytes `engineBuildId` carries. */
  engineBuildId: Hex;
  /** The image digest, `sha256:<hex>`. */
  digest: string;
  tdx: string[];
  nitro: string[];
  /** Where the Sigstore-attested copy of the file is published. */
  provenance: string;
}

/** The measurement ids in the published `measurements.json`. */
export function loadMeasurements(): Measurements {
  const m = JSON.parse(readFileSync(file, "utf8")) as {
    oci_digest: string;
    tdx: { id: string };
    nitro: { id: string };
  };
  return {
    engineBuildId: `0x${m.oci_digest.replace(/^sha256:/, "")}`,
    digest: m.oci_digest,
    tdx: [m.tdx.id],
    nitro: [m.nitro.id],
    provenance: `https://github.com/DavidZapataOh/keelson-paypal/releases/download/${m.oci_digest.replace(":", "-")}/measurements.json`,
  };
}
