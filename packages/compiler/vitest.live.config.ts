import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

const env = new URL("../../.env", import.meta.url);
if (existsSync(env)) process.loadEnvFile(env);

export default defineConfig({
  test: {
    name: "compiler:live",
    include: ["test/**/*.live.test.ts"],
  },
});
