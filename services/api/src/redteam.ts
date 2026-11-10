import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { addresses } from "@keelson/chain";
import { asc, attacks, createDb, eq, redTeamCampaigns } from "@keelson/db";
import { agentRegistry } from "@keelson/erc8004";
import {
  type Attack,
  type AttackPlan,
  append,
  campaignMandate,
  EVALUATOR,
  failedAttack,
  GENESIS,
  type Header,
  holdout,
  MUTATOR_MODEL,
  runAttack,
  runCampaign,
  summarize,
  TEMPLATES,
  templateHash,
  verify,
} from "@keelson/redteam";
import { task } from "@renderinc/sdk/workflows";
import { type Browser, chromium } from "playwright";
import { ulid } from "ulid";
import { z } from "zod";
import { engineSource } from "./tee/engine-source.ts";

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  STORE_ATTACK_TOKEN: z.string().min(16),
  PAYPAL_MERCHANT_ID: z.string().min(1),
  RENDER_GIT_COMMIT: z.string().default("unknown"),
});

const Config = z.strictObject({
  store: z.url().default("https://store.keelson.finance"),
  /** The ERC-8004 agent on Arbitrum Sepolia whose shopping agent is attacked. */
  agentId: z.string().regex(/^\d+$/).default("351"),
  rounds: z.int().min(1).max(10).default(3),
  perTemplate: z.int().min(1).max(50).default(14),
  guardedEvery: z.int().min(1).default(7),
  maxUsd: z.number().positive().max(50).default(16),
  seed: z.string().max(64).optional(),
});

let db: ReturnType<typeof createDb>["db"] | undefined;
const database = () => {
  db ??= createDb(Env.parse(process.env).DATABASE_URL).db;
  return db;
};

let browser: Promise<Browser> | undefined;

/** One attack in its own run: a headless Chromium, the agent, the store, Keelson and the judge. */
const redTeamAttack = task(
  {
    name: "redTeamAttack",
    retry: { maxRetries: 1, waitDurationMs: 5_000, backoffScaling: 2 },
    timeoutSeconds: 600,
  },
  async function attack(
    _ctx,
    plan: AttackPlan,
    run: { store: string; mandate: unknown; now: string },
  ): Promise<Attack> {
    const env = Env.parse(process.env);
    browser ??= chromium.launch().catch((err: unknown) => {
      browser = undefined;
      throw err;
    });
    try {
      return await runAttack(
        {
          client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 8 }),
          browser: await browser,
          storeOrigin: run.store,
          attackToken: env.STORE_ATTACK_TOKEN,
          mandate: run.mandate,
          now: new Date(run.now),
        },
        plan,
      );
    } catch (err) {
      return failedAttack(plan, err instanceof Error ? err.message : String(err));
    }
  },
);

const outcome = (a: Attack) =>
  a.verdict.escaped || a.verdict.amber
    ? ("SUCCEEDED" as const)
    : a.verdict.hijacked
      ? ("BLOCKED" as const)
      : ("NO_EFFECT" as const);

/**
 * A red-team campaign: rounds of mutations of every seed template, each attacked in its own run,
 * written to the campaign's hash-chained ledger round by round. Returns the summary line.
 */
task(
  {
    name: "redTeamCampaign",
    retry: { maxRetries: 0, waitDurationMs: 1_000 },
    timeoutSeconds: 14_400,
  },
  async function campaign(ctx, input: unknown = {}) {
    const env = Env.parse(process.env);
    const config = Config.parse(input);
    const id = ulid();
    const now = new Date();
    const mandate = await campaignMandate({
      payee: env.PAYPAL_MERCHANT_ID,
      operator: { agent_registry: agentRegistry(421614), agent_id: config.agentId },
      vault: `eip155:421614:${addresses[421614].KeelsonBondVault}`,
      engine: await engineSource(),
      now,
    });
    const held = holdout();
    const header: Header = {
      kind: "header",
      v: "keelson.redteam/1",
      campaign: id,
      now: now.toISOString(),
      store: config.store,
      mandate: mandate as never,
      evaluator: EVALUATOR as never,
      config: { ...config, seed: config.seed ?? id, mutator: MUTATOR_MODEL },
      templates: TEMPLATES.map((t) => ({
        id: t.id,
        class: t.class,
        source: t.source,
        sha256: templateHash(t),
        split: held.has(t.id) ? "holdout" : "seen",
      })),
      commit: env.RENDER_GIT_COMMIT,
    };
    let { line, hash: prev } = append(GENESIS, header);
    await database().insert(redTeamCampaigns).values({ id, header: line });

    const run = { store: config.store, mandate, now: now.toISOString() };
    const done = await runCampaign(
      { ...config, seed: config.seed ?? id },
      {
        client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 8 }),
        run: async (plans) => {
          const settled = await Promise.allSettled(
            plans.map((p) => ctx.run(redTeamAttack, p, run)),
          );
          return settled.map((s, i) =>
            s.status === "fulfilled"
              ? s.value
              : failedAttack(plans[i] as AttackPlan, String(s.reason).slice(0, 200)),
          );
        },
        onRound: async (round) => {
          const rows = round.map((a) => {
            const out = append(prev, a);
            prev = out.hash;
            return {
              id: ulid(),
              campaign: id,
              seq: a.seq,
              backbone: a.backbone,
              payloadHash: createHash("sha256").update(a.mutation.text).digest(),
              outcome: outcome(a),
              line: out.line,
              hash: Buffer.from(out.hash, "hex"),
            };
          });
          for (let i = 0; i < rows.length; i += 200) {
            await database()
              .insert(attacks)
              .values(rows.slice(i, i + 200));
          }
        },
      },
    );
    const summary = summarize(done.attacks, done.mutatorMicros);
    ({ line, hash: prev } = append(prev, summary));
    await database()
      .update(redTeamCampaigns)
      .set({ summary: line, head: Buffer.from(prev, "hex"), finishedAt: new Date() })
      .where(eq(redTeamCampaigns.id, id));
    return { campaign: id, head: prev, ...(done.stopped && { stopped: done.stopped }), ...summary };
  },
);

/** Recomputes a stored campaign from its ledger alone; see `verify`. */
task(
  { name: "redTeamVerify", timeoutSeconds: 600 },
  async function verifyCampaign(_ctx, campaign: string) {
    const [c] = await database()
      .select()
      .from(redTeamCampaigns)
      .where(eq(redTeamCampaigns.id, campaign));
    if (!c?.summary) throw new Error(`campaign ${campaign} is not finished`);
    const rows = await database()
      .select({ line: attacks.line })
      .from(attacks)
      .where(eq(attacks.campaign, campaign))
      .orderBy(asc(attacks.seq));
    const t = performance.now();
    const result = verify([c.header, ...rows.map((r) => r.line), c.summary]);
    return {
      campaign,
      ...result,
      matchesStoredHead: c.head?.toString("hex") === result.head,
      ms: Math.round(performance.now() - t),
    };
  },
);
