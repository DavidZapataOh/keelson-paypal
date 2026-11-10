import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "ui",
    include: ["test/**/*.test.{ts,tsx}"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
