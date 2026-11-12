import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "db",
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgres://postgres:keelson@localhost:5432/keelson",
    },
  },
});
