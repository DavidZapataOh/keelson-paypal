import { jcs } from "@keelson/core";
import { describe, expect, test } from "vitest";
import { append, GENESIS, type Line, verify } from "../src/ledger.ts";
import { ledger } from "./fixtures.ts";

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
