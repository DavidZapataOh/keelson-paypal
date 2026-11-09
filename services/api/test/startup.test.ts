import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const server = fileURLToPath(new URL("../src/server.ts", import.meta.url));

test("the server's module graph loads up to the environment check", () => {
  const run = spawnSync(process.execPath, [server], {
    env: { PATH: process.env.PATH ?? "" },
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(run.stderr).not.toContain("getOwnMetadataKeys");
  expect(run.stderr).toContain("ZodError");
}, 70_000);
