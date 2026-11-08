import { existsSync, readFileSync } from "node:fs";
import type { Hex } from "viem";

const file = new URL("../../../../engine/tee/measurements.json", import.meta.url);
/**
 * The published `measurements.json` files of other builds the API admits while the legs move from
 * one image to another, each kept byte for byte as it was attested. Absent outside a rotation.
 */
const rotationFile = new URL("../../../../engine/tee/measurements-rotation.json", import.meta.url);

/** One build both legs may run: its image digest and the measurement id of each leg. */
interface Build {
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
  /** Other builds whose signers are admitted during a rotation. */
  rotation: Build[];
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

/** The measurement ids in the published `measurements.json`, and any other builds admitted. */
export function loadMeasurements(): Measurements {
  const m = JSON.parse(readFileSync(file, "utf8")) as Published;
  const rotation = existsSync(rotationFile)
    ? (JSON.parse(readFileSync(rotationFile, "utf8")) as Published[]).map(build)
    : [];
  return {
    ...build(m),
    provenance: `https://github.com/DavidZapataOh/keelson-paypal/releases/download/${m.oci_digest.replace(":", "-")}/measurements.json`,
    rotation,
  };
}
