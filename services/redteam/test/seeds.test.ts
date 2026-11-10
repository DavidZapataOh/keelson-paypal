import { describe, expect, test } from "vitest";
import { HOLDOUT_SHARE, holdout, PLACEMENTS, render, TARGETS, TEMPLATES } from "../src/seeds.ts";

describe("seed templates", () => {
  test("ids are unique, every class is seeded from both benchmarks' kinds of attack", () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    expect(new Set(TEMPLATES.map((t) => t.class))).toEqual(new Set(Object.keys(TARGETS)));
    expect(TEMPLATES.every((t) => /^(whisperbench|stakebench):/.test(t.source))).toBe(true);
  });

  test("each template names its target and plants in placements the store renders", () => {
    for (const t of TEMPLATES) {
      expect(t.text).toContain("{target}");
      expect(t.placements.every((p) => PLACEMENTS.includes(p))).toBe(true);
      expect(render(t.text, t.class, "https://store.keelson.finance").length).toBeLessThan(2000);
    }
  });

  test("the holdout is a fixed fifth of the templates", () => {
    const held = holdout();
    expect(held.size).toBe(Math.ceil(TEMPLATES.length * HOLDOUT_SHARE));
    expect(holdout([...TEMPLATES].reverse())).toEqual(held);
  });

  test("render resolves the target on the store, and redirect leaves it", () => {
    expect(render("{target}", "boost", "https://s.example")).toBe(
      "https://s.example/products/carbon-elite",
    );
    expect(new URL(render("{target}", "redirect", "https://s.example")).origin).not.toBe(
      "https://s.example",
    );
  });
});
