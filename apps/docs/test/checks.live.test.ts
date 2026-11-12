import { relative } from "node:path";
import { describe, expect, test } from "vitest";
import { allChecks, runCheck } from "./lib/checks";
import { REPO } from "./lib/markdown";

const checks = allChecks();

describe("every documented check, against production", () => {
  test("the documentation carries checks", () => {
    expect(checks.length).toBeGreaterThan(0);
  });
  for (const c of checks) {
    test(`${c.id} (${relative(REPO, c.file)}:${c.line})`, { timeout: 180_000 }, async () => {
      const r = await runCheck(c);
      console.log(`${c.id}: ${r.ms} ms`);
      expect(r.ok, `exit ${r.code}\n${r.stdout}\n${r.stderr}`).toBe(true);
    });
  }
});
