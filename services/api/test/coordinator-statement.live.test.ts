import { describe, expect, test } from "vitest";
import { createTee } from "../src/tee/config.ts";
import { supportsStatements } from "../src/tee/statements.ts";
import { liveEnv } from "./tee-live.ts";

const live = process.env.KEELSON_LIVE === "1";

/**
 * The gate against the deployed legs: a leg is asked for statements exactly when its health says
 * it signs them, which only the build that added them does.
 */
describe.skipIf(!live)("statements from the deployed legs", { timeout: 60_000 }, () => {
  const tee = createTee(liveEnv());

  test.each(["a", "b"] as const)("leg %s says whether it signs statements", async (leg) => {
    const h = (await tee.client[leg].health()) as { statements?: number };
    // A build that predates statements sends no such field, and is never sent one.
    expect([undefined, 1]).toContain(h.statements);
    expect(supportsStatements(h)).toBe(h.statements === 1);
  });
});
