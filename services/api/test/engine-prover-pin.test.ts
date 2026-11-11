import { expect, test } from "vitest";
import { ENGINE_PROVER } from "../src/zk/engine.ts";

test("the prover is pinned to a published release", () => {
  expect(ENGINE_PROVER.url).toMatch(
    /^https:\/\/github\.com\/DavidZapataOh\/keelson-paypal\/releases\/download\/engine-proof-[0-9a-f]{7}\/keelson-engine-proof-linux-x64$/,
  );
  expect(ENGINE_PROVER.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(ENGINE_PROVER.sha256).not.toBe("0".repeat(64));
});
