import { jcs } from "@keelson/core";
import { describe, expect, test } from "vitest";
import type { AttackPlan } from "../src/attack.ts";
import { failedAttack } from "../src/attack.ts";
import { EVALUATOR, judge, keelson } from "../src/judge.ts";
import {
  type Attack,
  append,
  GENESIS,
  type Header,
  type Line,
  summarize,
  verify,
} from "../src/ledger.ts";
import { fallback } from "../src/mutator.ts";
import { TEMPLATES } from "../src/seeds.ts";
import { cart, mandate, NOW, STORE, url } from "./fixtures.ts";

const plan = (seq: number, backbone: "vulnerable" | "guarded" = "vulnerable"): AttackPlan => {
  const t = TEMPLATES[seq % TEMPLATES.length] as (typeof TEMPLATES)[number];
  return {
    seq,
    round: 1,
    template: t.id,
    class: t.class,
    split: "seen",
    mutation: fallback(t, seq),
    backbone,
  };
};

/** An attack whose agent proposed `lines`, priced and judged as the campaign does. */
function attack(seq: number, lines: [string, string, number][]): Attack {
  const p = plan(seq);
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

function ledger(): string[] {
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
  const attacks = [
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

// biome-ignore lint/suspicious/noExplicitAny: edits reach into arbitrary ledger fields.
type Edit = any;

describe("the ledger", () => {
  test("a campaign reproduces from its ledger alone", () => {
    const lines = ledger();
    const v = verify(lines);
    expect(v.errors).toEqual([]);
    expect(v).toMatchObject({ ok: true, lines: 6 });
    expect(v.head).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the summary counts what the attacks did", () => {
    const summary = JSON.parse(ledger().at(-1) as string);
    expect(summary.tallies.vulnerable.seen).toMatchObject({
      attacks: 3,
      excluded: 0,
      violates: 1,
      blocked: 1,
      escaped: 0,
      utility: 1,
      false_blocks: 0,
    });
    expect(summary.tallies.guarded.seen).toMatchObject({ attacks: 1, excluded: 1 });
    expect(summary.usd_micros).toBe(12_300 + 3 * 4400);
  });

  test("a changed verdict, a forged Keelson decision or a reordered line is caught", () => {
    const lines = ledger();
    const forge = (i: number, f: (o: Edit) => void) => {
      const copy = [...lines];
      const o = JSON.parse(copy[i] as string);
      f(o);
      copy[i] = jcs(o);
      return verify(copy);
    };
    expect(forge(1, (o) => (o.verdict.escaped = true)).errors.join()).toMatch(
      /line 2: breaks|verdict/,
    );
    // Rechaining after an edit still fails: the trace is recomputed from the cart.
    const relinked = (edit: (o: Edit) => void) => {
      let prev = GENESIS;
      return verify(
        lines.map((text, i) => {
          const o = JSON.parse(text);
          if (i === 1) edit(o);
          o.prev = prev;
          const out = append(prev, (({ prev: _, ...rest }) => rest)(o) as Line);
          prev = out.hash;
          return out.line;
        }),
      );
    };
    expect(relinked((o) => (o.trace.decision = "allow")).errors).toContain(
      "line 2: Keelson's trace does not reproduce",
    );
    expect(relinked((o) => (o.verdict.escaped = true)).errors).toEqual(
      expect.arrayContaining(["line 2: verdict does not reproduce", "summary does not reproduce"]),
    );
    expect(verify([lines[0], lines[2], lines[1], ...lines.slice(3)] as string[]).ok).toBe(false);
  });
});
