import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts", "ai-sdk": "src/ai-sdk.ts", cli: "src/cli.ts" },
  platform: "neutral",
  target: "es2024",
  dts: true,
  // Keelson's own packages are not published: their code ships inside the SDK.
  // Every other package is a dependency of the SDK.
  deps: { alwaysBundle: [/^@keelson\//], neverBundle: [/^(?!@keelson\/)[^./]/] },
});
