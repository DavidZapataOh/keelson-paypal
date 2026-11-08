import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "relayer",
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
