import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const script = fileURLToPath(new URL("../scripts/data.mjs", import.meta.url));
const offline = (out: string, extra: Record<string, string> = {}) => ({
  ...process.env,
  DOCS_API: "http://127.0.0.1:9",
  DOCS_LOG: "http://127.0.0.1:9",
  DOCS_RETRY_MS: "10",
  DOCS_DATA_DIR: out,
  ...extra,
});

describe("live values at build time", () => {
  test("a build without production marks live values unavailable instead of inventing them", () => {
    const out = mkdtempSync(join(tmpdir(), "docs-data-"));
    execFileSync("node", [script], { env: offline(out), stdio: "pipe" });
    const live = JSON.parse(readFileSync(join(out, "live.json"), "utf8"));
    expect(live).toEqual({ available: false });
    const examples = JSON.parse(readFileSync(join(out, "examples.json"), "utf8"));
    expect(examples).toEqual({ capturedAt: null, examples: {} });
  });

  test("the production build refuses to ship without live values", () => {
    const out = mkdtempSync(join(tmpdir(), "docs-data-"));
    expect(() =>
      execFileSync("node", [script], {
        env: offline(out, { DOCS_REQUIRE_LIVE: "1" }),
        stdio: "pipe",
      }),
    ).toThrow();
  });
});
