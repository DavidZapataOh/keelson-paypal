import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "monitor",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 240_000,
  },
});
