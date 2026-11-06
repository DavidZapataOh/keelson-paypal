import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "compiler:unit",
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.live.test.ts"],
  },
});
