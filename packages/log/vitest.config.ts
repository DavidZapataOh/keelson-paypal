import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "log:unit",
    include: ["test/**/*.test.ts"],
  },
});
