import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "alibi:unit",
    include: ["test/**/*.test.ts"],
  },
});
