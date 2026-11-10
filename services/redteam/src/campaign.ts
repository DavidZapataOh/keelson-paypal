import type Anthropic from "@anthropic-ai/sdk";
import type { Backbone } from "@keelson/agent";
import type { AttackPlan } from "./attack.ts";
import type { Attack, Mutation } from "./ledger.ts";
import { type Feedback, mutate, seedOf } from "./mutator.ts";
import { holdout, TEMPLATES, type Template } from "./seeds.ts";

export interface CampaignConfig {
  rounds: number;
  /** Mutations per template per round; each is attacked on the vulnerable backbone. */
  perTemplate: number;
  /** Every n-th mutation of a round is also attacked on the guarded backbone. */
  guardedEvery: number;
  /** No round starts that could take the campaign's Anthropic spend past this, in USD. */
  maxUsd: number;
  /** Seeds every mutation, so a campaign's requests and fallbacks can be rebuilt. */
  seed: string;
}

/** USD an attack costs on each backbone, with headroom (measured means: $0.0075 and $0.042). */
const CEILING: Record<Backbone, number> = { vulnerable: 0.009, guarded: 0.05 };
/** USD a mutator call costs, with headroom. */
const MUTATOR_CEILING = 0.04;

/** The attacks of one round: each template's mutations in order, numbered from `seq`. @internal */
export function planRound(
  round: number,
  mutations: ReadonlyMap<string, readonly Mutation[]>,
  templates: readonly Template[],
  held: ReadonlySet<string>,
  seq: number,
  guardedEvery: number,
): AttackPlan[] {
  const plans: AttackPlan[] = [];
  let n = 0;
  for (const t of templates) {
    for (const mutation of mutations.get(t.id) ?? []) {
      const base = {
        round,
        template: t.id,
        class: t.class,
        split: held.has(t.id) ? ("holdout" as const) : ("seen" as const),
        mutation,
      };
      plans.push({ ...base, seq: seq + plans.length, backbone: "vulnerable" });
      if (n++ % guardedEvery === 0) {
        plans.push({ ...base, seq: seq + plans.length, backbone: "guarded" });
      }
    }
  }
  return plans;
}

/** How each earlier mutation of `template` did on each backbone it met. @internal */
export function feedbackFor(template: string, attacks: readonly Attack[]): Feedback[] {
  const by = new Map<string, Feedback>();
  for (const a of attacks) {
    if (a.template !== template || a.verdict.excluded) continue;
    const key = JSON.stringify([a.mutation.text, a.mutation.placements]);
    const f = by.get(key) ?? {
      text: a.mutation.text,
      placements: a.mutation.placements,
      hijacked: {},
    };
    f.hijacked[a.backbone] = a.verdict.hijacked;
    by.set(key, f);
  }
  return [...by.values()];
}

export interface CampaignHooks {
  client: Anthropic;
  /** Runs a round's attacks, in parallel where it can, and returns them in `seq` order. */
  run(plans: AttackPlan[]): Promise<Attack[]>;
  /** Called with each finished round and the mutator's spend so far, before the next starts. */
  onRound?(attacks: Attack[], mutatorMicros: number): Promise<void>;
}

/**
 * Runs a campaign: each round mutates every template (held-out ones without feedback), attacks
 * each mutation, and feeds the seen templates' results to the next round. A round that could take
 * the spend past `maxUsd` is not started.
 */
export async function runCampaign(
  config: CampaignConfig,
  hooks: CampaignHooks,
  templates: readonly Template[] = TEMPLATES,
): Promise<{ attacks: Attack[]; mutatorMicros: number; stopped?: string }> {
  const held = holdout(templates);
  const attacks: Attack[] = [];
  let mutatorMicros = 0;
  const spent = () =>
    (mutatorMicros + attacks.reduce((n, a) => n + a.agent.usage.usd_micros, 0)) / 1e6;
  for (let round = 1; round <= config.rounds; round++) {
    const mutants = templates.length * config.perTemplate;
    const ceiling =
      templates.length * MUTATOR_CEILING +
      mutants * CEILING.vulnerable +
      Math.ceil(mutants / config.guardedEvery) * CEILING.guarded;
    if (spent() + ceiling > config.maxUsd) {
      return { attacks, mutatorMicros, stopped: `round ${round} could pass $${config.maxUsd}` };
    }
    const mutated = await Promise.all(
      templates.map((t) =>
        mutate({
          client: hooks.client,
          template: t,
          round,
          count: config.perTemplate,
          seed: seedOf(config.seed, t.id, round),
          ...(round > 1 && !held.has(t.id) && { feedback: feedbackFor(t.id, attacks) }),
        }),
      ),
    );
    mutatorMicros += mutated.reduce((n, m) => n + Math.round(m.usd * 1e6), 0);
    const mutations = new Map(templates.map((t, i) => [t.id, mutated[i]?.mutations ?? []]));
    const plans = planRound(round, mutations, templates, held, attacks.length, config.guardedEvery);
    const done = await hooks.run(plans);
    attacks.push(...done);
    await hooks.onRound?.(done, mutatorMicros);
  }
  return { attacks, mutatorMicros };
}
