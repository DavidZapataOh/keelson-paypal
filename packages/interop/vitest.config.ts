import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "interop:unit",
    include: ["test/**/*.test.ts"],
  },
});
