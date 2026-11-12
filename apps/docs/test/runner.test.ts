import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type Check, runCheck } from "./lib/checks";

const check = (script: string, expect = "^ok$"): Check => ({
  file: "t.mdoc",
  line: 1,
  id: "t",
  script,
  expect: new RegExp(expect, "m"),
});

describe("runCheck", () => {
  test("passes when stdout matches the expectation", async () => {
    const r = await runCheck(check("echo ok"));
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toBe("ok");
  });

  test("retries a failing command once, then reports its exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-"));
    const r = await runCheck(check(`echo x >> ${dir}/attempts; false`), {
      retries: 1,
      retryDelayMs: 10,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(1);
    expect(readFileSync(join(dir, "attempts"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("fails when stdout does not match", async () => {
    expect((await runCheck(check("echo no"), { retries: 0 })).ok).toBe(false);
  });

  test("stops a command that runs past its timeout", async () => {
    const r = await runCheck(check("sleep 3; echo ok"), { timeoutMs: 500, retries: 0 });
    expect(r.ok).toBe(false);
    expect(r.ms).toBeLessThan(2500);
  });
});
