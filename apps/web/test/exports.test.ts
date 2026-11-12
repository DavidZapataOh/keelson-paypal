import { CONFORMANCE, FORMATS } from "@keelson/interop";
import { expect, test } from "vitest";
import { EXPORTS, refusalOf } from "../lib/exports";

test("every format is offered once, named with the official tool that checks it", () => {
  expect(EXPORTS.map((e) => e.format)).toEqual([...FORMATS, "visa.pdf"]);
  for (const e of EXPORTS) {
    const base = e.format === "visa.pdf" ? "visa" : e.format;
    expect(e.checkedWith).toBe(CONFORMANCE[base].tool);
  }
});

test("every refusal the API names reads as a sentence", () => {
  for (const reason of [
    "denied",
    "no_cart",
    "v1_alibi",
    "no_merchant_origin",
    "no_http_key",
    "no_agent_key",
    "signer_unavailable",
  ]) {
    expect(refusalOf(reason)).toMatch(/^[A-Z].*\.$/);
  }
  expect(refusalOf("something new")).toBe("This export is not available for this purchase.");
});
