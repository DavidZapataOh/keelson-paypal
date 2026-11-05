import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "mandate:unit",
    include: ["test/**/*.test.ts"],
  },
});
