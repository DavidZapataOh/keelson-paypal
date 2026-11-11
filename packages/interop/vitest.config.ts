import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "interop",
    include: ["test/**/*.test.ts"],
  },
});
