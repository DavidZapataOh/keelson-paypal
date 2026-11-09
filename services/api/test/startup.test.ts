import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const entry = (name: string) => fileURLToPath(new URL(`../src/${name}`, import.meta.url));

// With an empty environment the server stops at its environment check and the workflow worker
// waits for tasks; either way the whole module graph has loaded.
test.each(["server.ts", "workflows.ts"])(
  "%s loads its module graph",
  (name) => {
    const run = spawnSync(process.execPath, [entry(name)], {
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(run.stderr).not.toContain("getOwnMetadataKeys");
    expect(run.stderr).not.toMatch(/SyntaxError|ERR_MODULE_NOT_FOUND|TypeError/);
  },
  30_000,
);
