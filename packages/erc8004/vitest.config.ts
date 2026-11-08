import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "erc8004",
    include: ["test/**/*.test.ts"],
  },
});
