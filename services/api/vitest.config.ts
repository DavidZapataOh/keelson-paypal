import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "api",
    include: ["test/**/*.test.ts"],
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgres://postgres:keelson@localhost:5432/keelson",
    },
  },
});
