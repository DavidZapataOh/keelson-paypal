import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "alibi:unit",
    include: ["test/**/*.test.ts"],
    // Full offline verifications take seconds each on a shared CI runner.
    testTimeout: 30_000,
  },
});
