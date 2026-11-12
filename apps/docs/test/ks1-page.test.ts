import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCustomId, parseInvoiceId, parseVerdictRef } from "@keelson/paypal/ids";
import { describe, expect, test } from "vitest";
import { fences, REPO } from "./lib/markdown";
import { BCP14 } from "./spec.test";

const page = readFileSync(join(REPO, "apps/docs/src/content/docs/reference/ks1.mdoc"), "utf8");
const vectors = JSON.parse(
  readFileSync(join(REPO, "packages/paypal/test/vectors/ks1-v1.json"), "utf8"),
) as {
  version: string;
  valid: { kind: string; value: string }[];
  invalid: { kind: string; value: string }[];
};
const parse = (kind: string, v: string) =>
  kind === "custom_id"
    ? parseCustomId(v)
    : kind === "invoice_id"
      ? parseInvoiceId(v)
      : parseVerdictRef(v);

describe("the PayPal Agent Mandate Extension", () => {
  test("states BCP 14 and its sections", () => {
    expect(page).toContain(BCP14);
    for (const h of [
      "Security considerations",
      "Privacy considerations",
      "Changelog",
      "Test vectors",
    ]) {
      expect(page).toMatch(new RegExp(`^## ${h}`, "m"));
    }
    expect(page).not.toMatch(/illustrative/i);
    expect(vectors.version).toBe("1.0.0");
  });

  test("has its grammar in ABNF", () => {
    expect(fences(page).some((f) => f.lang === "abnf")).toBe(true);
  });

  test("every example value on the page parses, and is a published test vector", () => {
    const published = new Set(vectors.valid.map((v) => v.value));
    const examples = [
      ...page.matchAll(
        /\b(ks1\.[sp][ma]\.[0-9A-HJKMNP-TV-Z]{26}\.[A-Za-z0-9_-]{43}|KS1-[0-9A-HJKMNP-TV-Z]{26}-\d{2}-[0-9A-HJKMNP-TV-Z]{26}|ksv1\.[0-9A-HJKMNP-TV-Z]{26}\.[A-Za-z0-9_-]{16})\b/g,
      ),
    ].map((m) => m[1] as string);
    expect(examples.length).toBeGreaterThanOrEqual(2);
    for (const e of examples) {
      expect(published.has(e), e).toBe(true);
      const kind = e.startsWith("ks1.")
        ? "custom_id"
        : e.startsWith("KS1-")
          ? "invoice_id"
          : "verdict_ref";
      expect(parse(kind, e), e).not.toBeNull();
    }
  });

  test("every invalid vector is rejected by the reference parser", () => {
    expect(vectors.invalid.length).toBeGreaterThanOrEqual(12);
    for (const v of vectors.invalid) expect(parse(v.kind, v.value), v.value).toBeNull();
  });
});
