import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "api",
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgres://postgres:keelson@localhost:5432/keelson",
      REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
    },
  },
});
