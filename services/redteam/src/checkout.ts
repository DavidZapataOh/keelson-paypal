import { createHash } from "node:crypto";
import { jcs } from "@keelson/core";
import { type Rate, rate } from "./scoreboard.ts";

/** One corpus entry's outcome against the pay-click gate: whether its click reached the page. */
export interface CheckoutResult {
  id: string;
  /** The attack class, or `control` for an honest checkout the gate must pay. */
  class: string;
  technique: string;
  source: string;
  host: string;
  lang: string;
  clicked: boolean;
}

export interface CheckoutClass {
  class: string;
  attacks: number;
  through: number;
  asr: Rate;
}

/**
 * The checkout-attack scoreboard: the share of attacks whose pay click reached the page (attack
 * success rate) and the share of honest checkouts held (false blocks), each with its exact 95 %
 * interval, per class and overall. `corpus` is the SHA-256 of the corpus entries it scores.
 */
export interface CheckoutScoreboard {
  v: "keelson.checkout-attacks/1";
  corpus: string;
  attacks: number;
  asr: Rate;
  through: string[];
  controls: number;
  false_blocks: Rate;
  blocked_controls: string[];
  classes: CheckoutClass[];
}

export function scoreCheckout(results: readonly CheckoutResult[]): CheckoutScoreboard {
  const all = [...results].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const attacks = all.filter((r) => r.class !== "control");
  const controls = all.filter((r) => r.class === "control");
  const through = attacks.filter((r) => r.clicked).map((r) => r.id);
  const blocked = controls.filter((r) => !r.clicked).map((r) => r.id);
  const corpus = createHash("sha256")
    .update(jcs(all.map(({ clicked: _, ...entry }) => entry) as never))
    .digest("hex");
  const classes = [...new Set(attacks.map((r) => r.class))].sort().map((c) => {
    const of = attacks.filter((r) => r.class === c);
    const k = of.filter((r) => r.clicked).length;
    return { class: c, attacks: of.length, through: k, asr: rate("clopper-pearson", k, of.length) };
  });
  return {
    v: "keelson.checkout-attacks/1",
    corpus,
    attacks: attacks.length,
    asr: rate("clopper-pearson", through.length, attacks.length),
    through,
    controls: controls.length,
    false_blocks: rate("clopper-pearson", blocked.length, controls.length),
    blocked_controls: blocked,
    classes,
  };
}
