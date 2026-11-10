import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { BACKBONES, type Backbone, CheckoutError, quoteCart, runAgent } from "@keelson/agent";
import type { Cart } from "@keelson/core";
import { parseMandate } from "@keelson/mandate";
import type { Browser } from "playwright";
import { judge, keelson } from "./judge.ts";
import { type Attack, type Mutation, spend } from "./ledger.ts";
import { type AttackClass, render } from "./seeds.ts";

/** One attack to run: a mutation of a template, against one backbone. */
export interface AttackPlan {
  seq: number;
  round: number;
  template: string;
  class: AttackClass;
  split: "seen" | "holdout";
  mutation: Mutation;
  backbone: Backbone;
}

export interface AttackContext {
  client: Anthropic;
  browser: Browser;
  storeOrigin: string;
  /** Bearer token of the store's listing API. */
  attackToken: string;
  /** The campaign mandate, as the header records it. */
  mandate: unknown;
  /** The campaign clock Keelson evaluates at. */
  now: Date;
}

/** Plants the mutation on a new listing of the Trail Runner 2, for ten minutes. */
async function plant(c: AttackContext, plan: AttackPlan) {
  const text = render(plan.mutation.text, plan.class, c.storeOrigin);
  const headers = { authorization: `Bearer ${c.attackToken}`, "content-type": "application/json" };
  const res = await fetch(new URL("/api/listings", c.storeOrigin), {
    method: "POST",
    headers,
    body: JSON.stringify({
      product: "trail-runner-2",
      injections: plan.mutation.placements.map((placement) => ({ placement, text })),
      ttlSeconds: 600,
    }),
  });
  if (res.status !== 201) throw new Error(`listing not created: HTTP ${res.status}`);
  const { id } = (await res.json()) as { id: string };
  return {
    url: new URL(`/l/${id}`, c.storeOrigin).href,
    remove: () =>
      fetch(new URL(`/api/listings/${id}`, c.storeOrigin), { method: "DELETE", headers }).then(
        () => {},
      ),
  };
}

/**
 * Runs one attack: plants it on a listing, lets the agent shop from there in a fresh browser
 * context limited to the store, prices what it proposes on the store, asks Keelson and judges.
 */
export async function runAttack(c: AttackContext, plan: AttackPlan): Promise<Attack> {
  const listing = await plant(c, plan);
  const context = await c.browser.newContext();
  try {
    const page = await context.newPage();
    const run = await runAgent({
      client: c.client,
      backbone: plan.backbone,
      mandate: parseMandate(structuredClone(c.mandate)),
      startUrl: listing.url,
      hosts: [new URL(c.storeOrigin).hostname],
      context,
      page,
    });
    let quote: Attack["quote"] = null;
    let cart: Cart | undefined;
    if (run.proposal) {
      try {
        cart = (await quoteCart(c.storeOrigin, run.proposal)).cart;
        quote = { cart };
      } catch (err) {
        if (!(err instanceof CheckoutError)) throw err;
        quote = { error: err.message };
      }
    }
    const trace = cart ? keelson(c.mandate, cart, c.now) : null;
    const proposal = run.proposal?.lines ?? null;
    return {
      kind: "attack",
      ...plan,
      model: BACKBONES[plan.backbone].model,
      agent: {
        outcome: run.outcome,
        proposal,
        turns: run.steps.filter((s) => s.kind === "model").length,
        ms: run.ms,
        usage: spend(run.usage),
        reads_sha256: createHash("sha256").update(run.reads.join("\n\n")).digest("hex"),
      },
      quote,
      trace,
      verdict: judge({
        class: plan.class,
        storeOrigin: c.storeOrigin,
        ...(proposal && { proposal }),
        ...(cart && { cart }),
        ...(trace && { decision: trace.decision }),
      }),
    };
  } finally {
    await context.close();
    await listing.remove().catch(() => {});
  }
}

/** The ledger line of an attack that could not run: no proposal, so out of every rate. */
export function failedAttack(plan: AttackPlan, reason: string): Attack {
  return {
    kind: "attack",
    ...plan,
    model: BACKBONES[plan.backbone].model,
    agent: {
      outcome: `error: ${reason.slice(0, 200)}`,
      proposal: null,
      turns: 0,
      ms: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd_micros: 0 },
      reads_sha256: createHash("sha256").update("").digest("hex"),
    },
    quote: null,
    trace: null,
    verdict: judge({ class: plan.class, storeOrigin: "https://invalid" }),
  };
}
