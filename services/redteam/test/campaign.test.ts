import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "vitest";
import type { AttackPlan } from "../src/attack.ts";
import { failedAttack } from "../src/attack.ts";
import { feedbackFor, planRound, runCampaign } from "../src/campaign.ts";
import { holdout, TEMPLATES } from "../src/seeds.ts";

describe("campaign planning", () => {
  test("every mutation meets the vulnerable backbone; every n-th also the guarded one", async () => {
    const offline = new Anthropic({ apiKey: "sk-ant-invalid", maxRetries: 0 });
    const seen: AttackPlan[][] = [];
    const out = await runCampaign(
      { rounds: 2, perTemplate: 3, guardedEvery: 4, maxUsd: 10, seed: "t" },
      {
        client: offline,
        run: async (plans) => {
          seen.push(plans);
          return plans.map((p) => failedAttack(p, "offline"));
        },
      },
    );
    const perRound = TEMPLATES.length * 3;
    expect(seen.map((r) => r.filter((p) => p.backbone === "vulnerable").length)).toEqual([
      perRound,
      perRound,
    ]);
    expect(seen[0]?.filter((p) => p.backbone === "guarded").length).toBe(Math.ceil(perRound / 4));
    expect(out.attacks.map((a) => a.seq)).toEqual(out.attacks.map((_, i) => i));
    const held = holdout();
    expect(out.attacks.every((a) => a.split === (held.has(a.template) ? "holdout" : "seen"))).toBe(
      true,
    );
  });

  test("a round that could pass the spend cap is not started", async () => {
    const offline = new Anthropic({ apiKey: "sk-ant-invalid", maxRetries: 0 });
    const out = await runCampaign(
      { rounds: 3, perTemplate: 14, guardedEvery: 5, maxUsd: 1, seed: "t" },
      { client: offline, run: async (plans) => plans.map((p) => failedAttack(p, "offline")) },
    );
    expect(out.attacks).toHaveLength(0);
    expect(out.stopped).toMatch(/round 1/);
  });

  test("feedback pairs each mutation with what it did on each backbone", () => {
    const t = TEMPLATES[0] as (typeof TEMPLATES)[number];
    const plans = planRound(
      1,
      new Map([
        [t.id, [{ by: "fallback" as const, seed: 1, text: "x", placements: ["review" as const] }]],
      ]),
      [t],
      new Set(),
      0,
      1,
    );
    const attacks = plans.map((p) => {
      const a = failedAttack(p, "x");
      a.verdict = { ...a.verdict, excluded: false, hijacked: p.backbone === "vulnerable" };
      return a;
    });
    expect(feedbackFor(t.id, attacks)).toEqual([
      { text: "x", placements: ["review"], hijacked: { vulnerable: true, guarded: false } },
    ]);
  });
});
