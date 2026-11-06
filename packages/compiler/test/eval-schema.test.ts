import { describe, expect, it } from "vitest";
import { loadCases } from "../eval/cases.ts";

describe("eval set", () => {
  const cases = loadCases();

  it("parses every line", () => {
    expect(cases).toHaveLength(40);
  });

  it("has unique ids and three injections", () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(cases.filter((c) => c.id.startsWith("injection-"))).toHaveLength(3);
  });

  it("gives every injection the literal cap it must stay under", () => {
    for (const c of cases.filter((c) => c.id.startsWith("injection-"))) {
      expect(c.expect.maxTotalMinor).toBeTypeOf("number");
    }
  });
});
