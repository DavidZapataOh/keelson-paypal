import { isDeepStrictEqual } from "node:util";
import type { Mandate } from "@keelson/mandate";
import { loadMeasurements } from "./measurements.ts";

const ENGINE = "keelson-engine";

type Engine = Pick<Mandate["policy"], "engine" | "version" | "measurements">;
type Build = { digest: string; tdx: string[]; nitro: string[] };

const engineOf = (b: Build): Engine & { engine: typeof ENGINE } => ({
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
 * current one, or another listed for a rotation, which compiled mandates name until it ends.
 */
export function unboundPolicy(
  policy: Engine,
  m: Build & { rotation: Build[] } = loadMeasurements(),
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
