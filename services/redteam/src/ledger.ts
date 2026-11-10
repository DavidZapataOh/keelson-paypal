import { createHash } from "node:crypto";
import type { Backbone, Usage } from "@keelson/agent";
import { type Cart, type Json, jcs } from "@keelson/core";
import { type Trace, traceJcs } from "@keelson/policy";
import { judge, keelson, type ProposedLine, type Verdict } from "./judge.ts";
import type { AttackClass, Placement } from "./seeds.ts";

/** The domain every ledger line is hashed under. */
const LEDGER_DST = "keelson/redteam/v1";
/** The `prev` of a campaign's first line. */
export const GENESIS: string = "0".repeat(64);

export interface Header {
  kind: "header";
  v: "keelson.redteam/1";
  campaign: string;
  /** The instant every attack's Keelson evaluation reads as its clock. */
  now: string;
  store: string;
  mandate: Json;
  evaluator: Json;
  config: Json;
  templates: Json;
  commit: string;
}

/** The mutation an attack planted: who wrote it, from what, and where it went on the listing. */
export interface Mutation {
  by: "model" | "fallback";
  model?: string;
  /** The seed of the fallback grammar, or of the request to the model. */
  seed: number;
  text: string;
  placements: Placement[];
}

/** An agent's token counts and cost; JCS has integers only, so USD is in millionths. */
export type Spend = Omit<Usage, "usd"> & { usd_micros: number };

/** `usage` in ledger form. */
export function spend({ usd, ...tokens }: Usage): Spend {
  return { ...tokens, usd_micros: Math.round(usd * 1e6) };
}

export interface Attack {
  kind: "attack";
  seq: number;
  round: number;
  template: string;
  class: AttackClass;
  split: "seen" | "holdout";
  mutation: Mutation;
  backbone: Backbone;
  model: string;
  agent: {
    outcome: string;
    proposal: ProposedLine[] | null;
    turns: number;
    ms: number;
    usage: Spend;
    /** SHA-256 of the page reads the model received, joined as the evidence joins them. */
    reads_sha256: string;
  };
  /** The store's priced cart, or why it would not price the proposal. */
  quote: { cart: Cart } | { error: string } | null;
  trace: Trace | null;
  verdict: Verdict;
}

/** Counts of one backbone on one split. */
export interface Tally {
  attacks: number;
  excluded: number;
  hijacked: number;
  violates: number;
  /** Carts that break the mandate and never reach money: denied, or not priced by the store. */
  blocked: number;
  escaped: number;
  amber: number;
  utility: number;
  /** Carts within the mandate that Keelson denied. */
  false_blocks: number;
  usd_micros: number;
}

export interface Summary {
  kind: "summary";
  attacks: number;
  /** What the agents and the mutator spent on the Anthropic API, in millionths of a USD. */
  usd_micros: number;
  mutator_usd_micros: number;
  tallies: Record<string, Record<string, Tally>>;
  /** Mutations by who wrote them. */
  mutations: { model: number; fallback: number };
}

export type Line = Header | Attack | Summary;
type Chained = Line & { prev: string };

/** `SHA-256(utf8(LEDGER_DST) || 0x00 || utf8(line))`, in hex. */
function lineHash(line: string): string {
  return createHash("sha256").update(`${LEDGER_DST}\0`).update(line).digest("hex");
}

/** Chains `line` after `prev`: its JCS text, with `prev` inside, and its hash. */
export function append(prev: string, line: Line): { line: string; hash: string } {
  const text = jcs({ ...line, prev } as unknown as Json);
  return { line: text, hash: lineHash(text) };
}

/** Adds one attack to the counts. */
function tally(t: Tally | undefined, a: Attack): Tally {
  const n = t ?? {
    attacks: 0,
    excluded: 0,
    hijacked: 0,
    violates: 0,
    blocked: 0,
    escaped: 0,
    amber: 0,
    utility: 0,
    false_blocks: 0,
    usd_micros: 0,
  };
  const v = a.verdict;
  return {
    attacks: n.attacks + 1,
    excluded: n.excluded + Number(v.excluded),
    hijacked: n.hijacked + Number(v.hijacked),
    violates: n.violates + Number(v.violates),
    blocked: n.blocked + Number(v.violates && v.keelson !== "allow"),
    escaped: n.escaped + Number(v.escaped),
    amber: n.amber + Number(v.amber),
    utility: n.utility + Number(v.utility),
    false_blocks: n.false_blocks + Number(!v.excluded && !v.violates && v.keelson === "deny"),
    usd_micros: n.usd_micros + a.agent.usage.usd_micros,
  };
}

/** The summary of `attacks`, plus what the mutator spent. */
export function summarize(attacks: readonly Attack[], mutatorMicros: number): Summary {
  const tallies: Summary["tallies"] = {};
  const mutations = { model: 0, fallback: 0 };
  for (const a of attacks) {
    const by = tallies[a.backbone] ?? {};
    by[a.split] = tally(by[a.split], a);
    tallies[a.backbone] = by;
    mutations[a.mutation.by]++;
  }
  const agent = attacks.reduce((n, a) => n + a.agent.usage.usd_micros, 0);
  return {
    kind: "summary",
    attacks: attacks.length,
    usd_micros: agent + mutatorMicros,
    mutator_usd_micros: mutatorMicros,
    tallies,
    mutations,
  };
}

export interface Verification {
  ok: boolean;
  lines: number;
  head: string;
  /** The first problems found, by line number. */
  errors: string[];
}

const same = (a: unknown, b: unknown) => jcs(a as Json) === jcs(b as Json);

/**
 * Recomputes a campaign from its ledger alone: the hash chain, each attack's Keelson trace from
 * its cart, the campaign mandate and the header's clock, each verdict from the recorded facts, and
 * the summary from the attacks. The mutator's spend is the one figure taken as recorded.
 */
export function verify(lines: readonly string[]): Verification {
  const errors: string[] = [];
  const fail = (i: number, what: string) => {
    if (errors.length < 20) errors.push(`line ${i + 1}: ${what}`);
  };
  let prev = GENESIS;
  let header: Header | undefined;
  let summary: Summary | undefined;
  const attacks: Attack[] = [];
  for (const [i, text] of lines.entries()) {
    const line = JSON.parse(text) as Chained;
    if (jcs(line as unknown as Json) !== text) fail(i, "not in JCS form");
    if (line.prev !== prev) fail(i, "breaks the chain");
    prev = lineHash(text);
    if (line.kind === "header") {
      if (i !== 0) fail(i, "header out of place");
      header = line;
    } else if (line.kind === "attack") {
      if (line.seq !== attacks.length) fail(i, `seq ${line.seq} out of order`);
      attacks.push(line);
      if (!header) {
        fail(i, "attack before the header");
        continue;
      }
      const cart = line.quote && "cart" in line.quote ? line.quote.cart : undefined;
      const trace = cart ? keelson(header.mandate, cart, new Date(header.now)) : null;
      if (
        trace === null
          ? line.trace !== null
          : !line.trace || !Buffer.from(traceJcs(trace)).equals(Buffer.from(traceJcs(line.trace)))
      ) {
        fail(i, "Keelson's trace does not reproduce");
      }
      const verdict = judge({
        class: line.class,
        storeOrigin: header.store,
        ...(line.agent.proposal && { proposal: line.agent.proposal }),
        ...(cart && { cart }),
        ...(trace && { decision: trace.decision }),
      });
      if (!same(verdict, line.verdict)) fail(i, "verdict does not reproduce");
    } else {
      if (i !== lines.length - 1) fail(i, "summary before the end");
      summary = line;
    }
  }
  if (!header) errors.push("no header");
  if (!summary) errors.push("no summary");
  else {
    const { prev: _, ...recorded } = summary as Summary & { prev?: string };
    if (!same(summarize(attacks, summary.mutator_usd_micros), recorded)) {
      errors.push("summary does not reproduce");
    }
  }
  return { ok: errors.length === 0, lines: lines.length, head: prev, errors };
}
