import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { engineSource } from "../src/tee/engine-source.ts";

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
