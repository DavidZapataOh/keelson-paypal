import { describe, expect, test } from "vitest";
import { fixtures } from "../../../packages/alibi/test/fixtures.ts";
import { warmAlibiVerifier } from "../src/alibi/warm.ts";

describe("warmAlibiVerifier", () => {
  test("verifies an issued Alibi and reports how long it took", async () => {
    const f = fixtures[0];
    if (!f) throw new Error("no fixture");
    const ms = await warmAlibiVerifier(async () => f.bundle);
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  test("does nothing when no Alibi was issued yet", async () => {
    expect(await warmAlibiVerifier(async () => undefined)).toBeUndefined();
  });
});
