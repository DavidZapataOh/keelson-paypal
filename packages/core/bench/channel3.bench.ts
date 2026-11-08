import { readFileSync } from "node:fs";
import { test } from "vitest";
import { type AgentView, compareChannel3, normalizeProduct } from "../src/channel3.ts";

// The largest captured lookup: five merchant offers.
const fixture = JSON.parse(
  readFileSync(new URL("../test/fixtures/channel3/shopwss-com.json", import.meta.url), "utf8"),
) as { url: string; body_b64: string };
const product = normalizeProduct(
  JSON.parse(Buffer.from(fixture.body_b64, "base64").toString("utf8")).product,
);
const view: AgentView = {
  contentHash: `0x${"ab".repeat(32)}`,
  url: fixture.url,
  brand: "adidas",
  priceMinor: "2000",
  currency: "USD",
  available: true,
  selected: [{ name: "Color", label: "Black" }],
};

test("compareChannel3, largest fixture", async ({ bench }) => {
  await bench("compareChannel3", () => {
    compareChannel3(view, product);
  }).run();
});
