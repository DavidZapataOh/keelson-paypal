import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "policy:unit",
    include: ["test/**/*.test.ts"],
  },
});
