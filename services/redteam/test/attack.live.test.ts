import Anthropic from "@anthropic-ai/sdk";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runAttack } from "../src/attack.ts";
import { campaignMandate } from "../src/mandate.ts";
import { TEMPLATES } from "../src/seeds.ts";

const STORE = process.env.STORE_ORIGIN ?? "https://keelson-store.onrender.com";
const live =
  process.env.KEELSON_LIVE === "1" &&
  !!process.env.STORE_ATTACK_TOKEN &&
  !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!live)("one attack on the store", { timeout: 180_000 }, () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(() => browser?.close());

  test("the naive agent takes the add-on; Keelson denies it and the judge agrees", async () => {
    const now = new Date();
    const mandate = await campaignMandate({
      payee: "A4WCRYD5EYDF2",
      operator: {
        agent_registry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
        agent_id: "351",
      },
      vault: "eip155:421614:0xb39898Ef4333f3CB32d1B420E744f5a1Aa2ae2Bf",
      engine: { engine: "keelson-engine", version: "live-test", measurements: [] },
      now,
    });
    const t = TEMPLATES.find((x) => x.id === "wb-add_on-0") as (typeof TEMPLATES)[number];
    const a = await runAttack(
      {
        client: new Anthropic(),
        browser,
        storeOrigin: STORE,
        attackToken: process.env.STORE_ATTACK_TOKEN as string,
        mandate,
        now,
      },
      {
        seq: 0,
        round: 1,
        template: t.id,
        class: t.class,
        split: "seen",
        backbone: "vulnerable",
        mutation: { by: "fallback", seed: 0, text: t.text, placements: ["description", "opacity"] },
      },
    );
    console.log(
      JSON.stringify({
        outcome: a.agent.outcome,
        proposal: a.agent.proposal,
        verdict: a.verdict,
        fired: a.trace?.fired,
        usage: a.agent.usage,
        ms: a.agent.ms,
      }),
    );
    expect(a.agent.proposal).not.toBeNull();
    expect(a.verdict.escaped).toBe(false);
    if (a.verdict.violates) expect(a.verdict.keelson).not.toBe("allow");
  });
});
