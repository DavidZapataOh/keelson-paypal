import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { verifyAlibi } from "@keelson/alibi/verify";
import { expect, test } from "vitest";
import { PINNED_COMMITS } from "../scripts/vendor.ts";
import { ALLOW_CARD, ALLOW_PAYPAL, alibi, DENY_PAYPAL, NOW } from "./fixtures.ts";

interface Pin {
  path: string;
  source: string;
  commit: string;
  sha256: string;
}

const pins = JSON.parse(readFileSync(new URL("../vendor/PINS.json", import.meta.url), "utf8")) as {
  files: Pin[];
};

test("every vendored file is byte-identical to its pinned upstream", () => {
  expect(pins.files.length).toBeGreaterThan(40);
  for (const f of pins.files) {
    const bytes = readFileSync(new URL(`../vendor/${f.path}`, import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex"), f.path).toBe(f.sha256);
  }
  expect(new Set(pins.files.map((f) => f.commit))).toEqual(new Set(Object.values(PINNED_COMMITS)));
  expect(PINNED_COMMITS).toMatchObject({
    ap2: "e1ea56db72a6385bce3e5c1112b3a56ce60acb43",
    goodmeta: "41dff653dea4a3025ca6e1d5339121cd8a1623a5",
    ucp: "87dd4b1fcff9105d68173120897237fa784c74ef",
    acp: "7fdd78df677a94dce04c770644b0fbbb1401272b",
    webBotAuth: "01c0d10a5f00d4e77cc5677576a7a2b6e4954d50",
  });
  expect(PINNED_COMMITS.negativeVectors).toMatch(/^eb51afe2[0-9a-f]{32}$/);
});

test.each([ALLOW_PAYPAL, DENY_PAYPAL, ALLOW_CARD])("fixture %s verifies offline", async (id) => {
  const r = await verifyAlibi(alibi(id), { chain: null, now: new Date(NOW * 1000) });
  expect(r.verdict).toBe("verified-offline");
});
