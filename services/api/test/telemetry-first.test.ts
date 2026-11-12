import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// The pg instrumentation patches `pg` as it loads, and `pg` reaches the server through ESM
// imports that run before any module of the server could start tracing: `--import` starts it
// before the server's modules load, or no query is timed (no Postgres time in Server-Timing).
test("the server starts tracing before it loads", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts.start).toBe("node --import ./dist/telemetry.js dist/server.js");
});
