import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createTee } from "../src/tee/config.ts";
import { loadMeasurements } from "../src/tee/measurements.ts";

const rotationFile = new URL("../../../engine/tee/measurements-rotation.json", import.meta.url);

test("each leg admits the current build and every other build listed for a rotation", () => {
  const m = loadMeasurements();
  const listed = existsSync(rotationFile)
    ? (JSON.parse(readFileSync(rotationFile, "utf8")) as { oci_digest: string }[])
    : [];
  expect(m.rotation.map((p) => p.digest)).toEqual(listed.map((p) => p.oci_digest));

  const tee = createTee({
    TEE_A_URL: "https://a.invalid",
    TEE_B_URL: "https://b.invalid",
    KEELSON_TEE_TOKEN: "t",
  });
  expect(tee.expect.a.measurements).toEqual(m.tdx);
  expect(tee.expect.b.measurements).toEqual(m.nitro);
  expect(tee.expect.a.rotation).toEqual(
    m.rotation.map((p) => ({ engineBuildId: p.engineBuildId, measurements: p.tdx })),
  );
  expect(tee.expect.b.rotation).toEqual(
    m.rotation.map((p) => ({ engineBuildId: p.engineBuildId, measurements: p.nitro })),
  );
});
