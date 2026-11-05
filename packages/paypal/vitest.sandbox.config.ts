import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "paypal:sandbox",
    include: ["test/sandbox/**/*.sandbox.test.ts"],
    testTimeout: 120_000,
    fileParallelism: false,
  },
});
