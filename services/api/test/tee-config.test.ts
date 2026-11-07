import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { LEG_TIMEOUT_MS } from "../src/tee/config.ts";

test("leg a waits longer than the engine's PayPal read can take", () => {
  const source = readFileSync(
    new URL("../../../engine/tee/src/paypal.rs", import.meta.url),
    "utf8",
  );
  const secs = Number(/const TIMEOUT: Duration = Duration::from_secs\((\d+)\);/.exec(source)?.[1]);
  expect(secs).toBeGreaterThan(0);
  expect(LEG_TIMEOUT_MS.a).toBeGreaterThan(secs * 1000);
  expect(LEG_TIMEOUT_MS.b).toBe(500);
});
