import type { Cart } from "@keelson/core";
import type { Mandate } from "@keelson/mandate";
import { type AttackPlan, failedAttack } from "../src/attack.ts";
import { EVALUATOR, judge, keelson } from "../src/judge.ts";
import { type Attack, append, GENESIS, type Header, type Line, summarize } from "../src/ledger.ts";
import { campaignMandate } from "../src/mandate.ts";
import { fallback } from "../src/mutator.ts";
import { TEMPLATES } from "../src/seeds.ts";

export const STORE = "https://store.keelson.finance";
export const NOW = new Date("2026-11-10T12:00:00.000Z");

export const mandate: Mandate = await campaignMandate({
  payee: "A4WCRYD5EYDF2",
  operator: {
    agent_registry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    agent_id: "351",
  },
  vault: "eip155:421614:0xb39898Ef4333f3CB32d1B420E744f5a1Aa2ae2Bf",
  engine: { engine: "keelson-engine", version: "9967b89c2fed", measurements: [] },
  now: NOW,
});

/** The store's catalog, as its `POST /api/cart` prices it. */
const CATALOG: Record<string, [sku: string, cents: number, category: string, color: string]> = {
  "trail-runner-2": ["RF-TRL2", 13_900, "gpt:187", "Moss"],
  "tempo-3": ["RF-TMP3", 12_900, "gpt:187", "Black"],
  "carbon-elite": ["RF-CRBE", 24_900, "gpt:187", "White"],
  "premium-bundle": ["RF-PRMB", 34_000, "gpt:988", "Mixed"],
};

/** The cart the store quotes for `lines` of `[handle, size, qty]`. */
export function cart(...lines: [string, string, number][]): Cart {
  return {
    merchant: "mrc_runfast",
    currency: "USD",
    lines: lines.map(([h, size, qty]) => {
      const [sku, unit_minor, category, color] = CATALOG[h] as [string, number, string, string];
      return { sku: `${sku}-${size}`, size, color, category, qty, unit_minor };
    }),
    return_days: 30,
    returns_free: true,
  };
}

export const url = (handle: string): string => `${STORE}/products/${handle}`;

export const plan = (
  seq: number,
  backbone: "vulnerable" | "guarded" = "vulnerable",
  split: "seen" | "holdout" = "seen",
): AttackPlan => {
  const t = TEMPLATES[seq % TEMPLATES.length] as (typeof TEMPLATES)[number];
  return {
    seq,
    round: 1,
    template: t.id,
    class: t.class,
    split,
    mutation: fallback(t, seq),
    backbone,
  };
};

/** An attack whose agent proposed `lines`, priced and judged as the campaign does. */
export function attack(
  seq: number,
  lines: [string, string, number][],
  split: "seen" | "holdout" = "seen",
): Attack {
  const p = plan(seq, "vulnerable", split);
  const c = cart(...lines);
  const trace = keelson(mandate, c, NOW);
  const proposal = lines.map(([h, size, qty]) => ({ product_url: url(h), size, qty }));
  return {
    kind: "attack",
    ...p,
    model: "claude-haiku-4-5",
    agent: {
      outcome: "proposed",
      proposal,
      turns: 2,
      ms: 7000,
      usage: { input: 2300, output: 420, cacheRead: 0, cacheWrite: 0, usd_micros: 4400 },
      reads_sha256: "0".repeat(64),
    },
    quote: { cart: c },
    trace,
    verdict: judge({
      class: p.class,
      storeOrigin: STORE,
      proposal,
      cart: c,
      decision: trace.decision,
    }),
  };
}

/** A chained ledger of `attacks`, or of a small fixed campaign. */
export function ledger(attacks?: Attack[]): string[] {
  const header: Header = {
    kind: "header",
    v: "keelson.redteam/1",
    campaign: "test",
    now: NOW.toISOString(),
    store: STORE,
    mandate: mandate as never,
    evaluator: EVALUATOR as never,
    config: {},
    templates: [],
    commit: "test",
  };
  attacks ??= [
    attack(0, [["carbon-elite", "10", 1]]),
    attack(1, [["trail-runner-2", "10", 1]]),
    attack(2, [["tempo-3", "10", 1]]),
    failedAttack(plan(3, "guarded"), "browser crashed"),
  ];
  const lines: Line[] = [header, ...attacks, summarize(attacks, 12_300)];
  let prev = GENESIS;
  return lines.map((l) => {
    const out = append(prev, l);
    prev = out.hash;
    return out.line;
  });
}
