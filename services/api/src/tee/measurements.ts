import { existsSync, readFileSync } from "node:fs";
import type { Hex } from "viem";

const file = new URL("../../../../engine/tee/measurements.json", import.meta.url);
/**
 * The published `measurements.json` files of builds the API still admits while the legs move to a
 * new one, each kept byte for byte as it was attested. Absent outside a rotation.
 */
const previousFile = new URL("../../../../engine/tee/measurements-previous.json", import.meta.url);

/** One build both legs may run: its image digest and the measurement id of each leg. */
export interface Build {
  /** The image digest, as the 32 bytes `engineBuildId` carries. */
  engineBuildId: Hex;
  /** The image digest, `sha256:<hex>`. */
  digest: string;
  tdx: string[];
  nitro: string[];
}

interface Measurements extends Build {
  /** Where the Sigstore-attested copy of the file is published. */
  provenance: string;
  /** Earlier builds whose signers are still admitted. */
  previous: Build[];
}

interface Published {
  oci_digest: string;
  tdx: { id: string };
  nitro: { id: string };
}

const build = (m: Published): Build => ({
  engineBuildId: `0x${m.oci_digest.replace(/^sha256:/, "")}`,
  digest: m.oci_digest,
  tdx: [m.tdx.id],
  nitro: [m.nitro.id],
});

/** The measurement ids in the published `measurements.json`, and any earlier builds admitted. */
export function loadMeasurements(): Measurements {
  const m = JSON.parse(readFileSync(file, "utf8")) as Published;
  const previous = existsSync(previousFile)
    ? (JSON.parse(readFileSync(previousFile, "utf8")) as Published[]).map(build)
    : [];
  return {
    ...build(m),
    provenance: `https://github.com/DavidZapataOh/keelson-paypal/releases/download/${m.oci_digest.replace(":", "-")}/measurements.json`,
    previous,
  };
}
