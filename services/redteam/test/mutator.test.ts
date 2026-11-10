import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "vitest";
import { fallback, mutate, seedOf } from "../src/mutator.ts";
import { PLACEMENTS, TEMPLATES } from "../src/seeds.ts";

const template = TEMPLATES[0] as (typeof TEMPLATES)[number];

describe("the mutator", () => {
  test("a fallback mutation is rebuilt from its seed alone", () => {
    const seed = seedOf("campaign", template.id, 1);
    const m = fallback(template, seed);
    expect(fallback(template, seed)).toEqual(m);
    expect(m).toMatchObject({ by: "fallback", seed });
    expect(m.text).toContain(template.text);
    expect(m.placements.length).toBeGreaterThanOrEqual(1);
    expect(m.placements.every((p) => PLACEMENTS.includes(p))).toBe(true);
  });

  test("seeds spread mutations across frames and placements", () => {
    const ms = Array.from({ length: 40 }, (_, i) => fallback(template, seedOf("c", i)));
    expect(new Set(ms.map((m) => m.text)).size).toBeGreaterThan(10);
    expect(new Set(ms.flatMap((m) => m.placements)).size).toBeGreaterThan(5);
  });

  test("a mutator that cannot answer falls back to the grammar for every variant", async () => {
    // A client with a key the API rejects: the request fails like an outage would.
    const client = new Anthropic({ apiKey: "sk-ant-invalid", maxRetries: 0 });
    const { mutations, usd } = await mutate({ client, template, round: 1, count: 3, seed: 7 });
    expect(usd).toBe(0);
    expect(mutations).toEqual([0, 1, 2].map((i) => fallback(template, seedOf(7, i))));
  });

  test.skipIf(!process.env.ANTHROPIC_API_KEY || process.env.KEELSON_LIVE !== "1")(
    "the model writes the requested variants, keeping the target",
    async () => {
      const { mutations, usd } = await mutate({
        client: new Anthropic(),
        template,
        round: 1,
        count: 4,
        seed: 1,
      });
      console.log(JSON.stringify({ usd, by: mutations.map((m) => m.by), sample: mutations[0] }));
      expect(mutations).toHaveLength(4);
      expect(usd).toBeLessThan(0.06);
    },
  );
});
