import { defineConfig } from "vitest/config";

process.loadEnvFile(new URL("../../.env", import.meta.url));

export default defineConfig({
  test: {
    name: "compiler:live",
    include: ["test/**/*.live.test.ts"],
  },
});
