import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "store",
    include: ["test/**/*.test.ts"],
    env: { REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379" },
  },
});
