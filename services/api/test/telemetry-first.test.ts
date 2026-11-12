import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const run = promisify(execFile);

// The pg instrumentation patches `pg` as it loads, and `pg` reaches the server through ESM
// imports that run before any module of the server could start tracing: tracing has to start
// from `--import`, or no query is timed and Server-Timing has no Postgres time.
test("started as `pnpm start` starts it, the server times its Postgres queries as Postgres time", {
  timeout: 30_000,
}, async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  const [node, ...args] = pkg.scripts.start?.split(" ") ?? [];
  expect(node).toBe("node");
  const flag = args.indexOf("--import");
  expect(flag).toBeGreaterThanOrEqual(0);
  // The build compiles src/<name>.ts to dist/<name>.js.
  const preload = (args[flag + 1] as string).replace(/^\.\/dist\/(.+)\.js$/, "./src/$1.ts");
  const { stdout } = await run(
    process.execPath,
    ["--no-warnings", "--import", preload, "test/pg-timed-child.ts"],
    { cwd: new URL("..", import.meta.url).pathname, env: process.env },
  );
  const timings = JSON.parse(stdout) as Record<string, number>;
  expect(timings["db.LOGGED"]).toBeGreaterThanOrEqual(50);
  // Connecting to Postgres is not an outbound call either.
  const host = new URL(process.env.DATABASE_URL as string).hostname;
  expect(Object.keys(timings)).not.toContain(`out.${host}`);
});
