import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "paypal:unit",
    include: ["test/**/*.test.ts"],
    exclude: ["test/sandbox/**"],
  },
});
