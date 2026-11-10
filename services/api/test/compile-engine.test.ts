import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { engineSource, unboundPolicy } from "../src/tee/engine-source.ts";
import { loadMeasurements } from "../src/tee/measurements.ts";

const published = JSON.parse(
  readFileSync(new URL("../../../engine/tee/measurements.json", import.meta.url), "utf8"),
) as { engine: string; oci_digest: string; tdx: { id: string }; nitro: { id: string } };

test("a compiled mandate names exactly the published measurement ids", async () => {
  const source = await engineSource();
  expect(source.engine).toBe(published.engine);
  expect(source.measurements).toEqual([published.tdx.id, published.nitro.id]);
});

test("the build id the legs are held to is the published image digest", async () => {
  const { loadMeasurements } = await import("../src/tee/measurements.ts");
  expect(loadMeasurements().digest).toBe(published.oci_digest);
});

test("the policy compile fills is bound", async () => {
  expect(unboundPolicy(await engineSource())).toEqual([]);
});

test("a mandate compiled for a build still admitted in a rotation stays bound", () => {
  const current = loadMeasurements();
  const previous = {
    engineBuildId: `0x${"ab".repeat(32)}` as const,
    digest: `sha256:${"ab".repeat(32)}`,
    tdx: [`tdx:${"cd".repeat(32)}`],
    nitro: [`nitro:${"ef".repeat(32)}`],
  };
  const rotating = { ...current, rotation: [previous] };
  const policy = {
    engine: "keelson-engine",
    version: "abababababab",
    measurements: [...previous.tdx, ...previous.nitro],
  };
  expect(unboundPolicy(policy, rotating)).toEqual([]);
  expect(unboundPolicy(policy, current)).toEqual(["policy.version", "policy.measurements"]);
  expect(
    unboundPolicy({ ...policy, measurements: [...current.tdx, ...current.nitro] }, rotating),
  ).toEqual(["policy.measurements"]);
});
