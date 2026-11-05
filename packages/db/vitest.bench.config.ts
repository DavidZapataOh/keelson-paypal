import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "db-bench",
    include: ["bench/**/*.bench.ts"],
    testTimeout: 300_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
