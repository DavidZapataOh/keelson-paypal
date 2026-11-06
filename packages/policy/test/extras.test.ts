import { policyToJson } from "@cedar-policy/cedar-wasm";
import { describe, expect, it } from "vitest";
import { compileExtras, ExtrasError, MAX_EXTRAS, parseExtras } from "../src/extras.ts";

describe("extras", () => {
  it("accept exactly the closed grammar", () => {
    const ok = parseExtras([
      { type: "max_unit_price", minor: 100 },
      { type: "deny_merchant", id: "mrc_runfast" },
      { type: "deny_category", id: "gpt:187" },
      { type: "require_return_days", min: 30 },
    ]);
    expect(ok).toHaveLength(4);
    for (const bad of [
      { type: "permit" },
      { type: "forbid", when: "true" },
      { type: "deny_merchant", id: "mrc_a", effect: "permit" },
      { type: "max_unit_price", minor: "100" },
      { type: "max_unit_price", minor: 1.5 },
      { type: "deny_category" },
      { minor: 100 },
      { type: "toString", id: "x" },
      "permit(principal, action, resource);",
    ]) {
      expect(() => parseExtras([bad]), JSON.stringify(bad)).toThrow(TypeError);
    }
  });

  it("compile only to annotated forbids", () => {
    const extras = parseExtras([
      { type: "max_unit_price", minor: 12_500 },
      { type: "deny_merchant", id: 'mrc_a" } permit(principal, action, resource); //' },
      { type: "deny_category", id: "gpt:187" },
      { type: "require_return_days", min: 0 },
    ]);
    const compiled = compileExtras(extras);
    expect(compiled.map(([id]) => id)).toEqual(["extra.0", "extra.1", "extra.2", "extra.3"]);
    for (const [id, text] of compiled) {
      const json = policyToJson(text);
      expect(json.type).toBe("success");
      if (json.type !== "success") continue;
      expect(json.json.effect).toBe("forbid");
      expect(json.json.annotations).toMatchObject({ id, color: "green" });
    }
  });

  it("reject meaningless literals and too many extras", () => {
    const reason = (extras: unknown[]) => {
      try {
        compileExtras(parseExtras(extras));
      } catch (e) {
        if (e instanceof ExtrasError) return [e.index, e.reason];
      }
      return undefined;
    };
    expect(reason([{ type: "max_unit_price", minor: 0 }])).toEqual([0, "price"]);
    expect(reason([{ type: "require_return_days", min: -1 }])).toEqual([0, "return_days"]);
    expect(reason([{ type: "deny_merchant", id: "mrc_" }])).toEqual([0, "merchant_id"]);
    expect(reason([{ type: "deny_merchant", id: "mrc_a\u200bb" }])).toEqual([0, "merchant_id"]);
    expect(reason([{ type: "deny_category", id: "gpt:01" }])).toEqual([0, "category_id"]);
    const many = Array.from({ length: MAX_EXTRAS + 1 }, () => ({
      type: "deny_category",
      id: "gpt:1",
    }));
    expect(reason(many)).toEqual([MAX_EXTRAS, "too_many"]);
  });
});
