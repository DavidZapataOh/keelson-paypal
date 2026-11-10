import { isDeepStrictEqual } from "node:util";
import type { Mandate } from "@keelson/mandate";
import { type Build, loadMeasurements } from "./measurements.ts";

const ENGINE = "keelson-engine";

type Engine = Pick<Mandate["policy"], "engine" | "version" | "measurements">;
type Admitted = Pick<Build, "digest" | "tdx" | "nitro">;

/** The builds the legs are held to, read once at startup as `createTee` reads them. */
const admitted = loadMeasurements();

const engineOf = (b: Admitted): Engine & { engine: typeof ENGINE } => ({
  engine: ENGINE,
  version: b.digest.replace("sha256:", "").slice(0, 12),
  measurements: [...b.tdx, ...b.nitro],
});

/** The policy engine build and the TEE measurements a compiled mandate names. */
export async function engineSource(): Promise<Engine & { engine: typeof ENGINE }> {
  return engineOf(loadMeasurements());
}

/**
 * The `policy` fields of a signed mandate that name no build the legs are admitted to run: the
 * current one, or one listed for a rotation, which mandates compiled before the swap name until
 * the rotation ends.
 */
export function unboundPolicy(
  policy: Engine,
  m: Admitted & { rotation: Admitted[] } = admitted,
): string[] {
  const builds = [m, ...m.rotation].map(engineOf);
  const build = builds.find((b) => b.version === policy.version);
  return [
    ...(policy.engine === ENGINE ? [] : ["policy.engine"]),
    ...(build ? [] : ["policy.version"]),
    ...(builds.some(
      (b) => (!build || b === build) && isDeepStrictEqual(b.measurements, policy.measurements),
    )
      ? []
      : ["policy.measurements"]),
  ];
}
