import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { TEE_BUILDS } from "../src/verify/trust.ts";

const measurements = JSON.parse(
  readFileSync(new URL("../../../engine/tee/measurements.json", import.meta.url), "utf8"),
) as { oci_digest: string; tdx: { id: string }; nitro: { id: string } };

test("the build the legs run is one an Alibi may be countersigned by", () => {
  expect(TEE_BUILDS).toContainEqual({
    engineBuildId: measurements.oci_digest.replace("sha256:", "0x"),
    tdx: measurements.tdx.id,
    nitro: measurements.nitro.id,
  });
});
