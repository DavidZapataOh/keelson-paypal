import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { betaQuantile, type Exposure, grade, type Prior, priorOf } from "../src/risk.ts";
import type { Rate, Row, Scoreboard } from "../src/scoreboard.ts";

/** Agent 351's coverages as its `CoverageLocked` logs record them on Arbitrum Sepolia. */
const recorded = JSON.parse(
  readFileSync(new URL("./coverages-351.json", import.meta.url), "utf8"),
) as { released: number; slashed: number; amountsMinor: number[] };

const rate = (k: number, n: number): Rate => ({
  method: "wilson",
  k,
  n,
  ppm: null,
  lo_ppm: 0,
  hi_ppm: 0,
});

/** The pooled row of a published scoreboard, reduced to the counts the prior reads. */
function board(campaign: string, asr: [number, number], esc: [number, number], amber: number) {
  const all = {
    backbone: "all",
    split: "all",
    proposed: asr[1],
    asr: rate(...asr),
    escape: rate(...esc),
    amber: { k: amber, n: asr[1], ppm: null },
  } as Row;
  return { campaign, complete: true, rows: [all] } as Scoreboard;
}

// The pooled `all/all` counts of the finished campaigns on api.keelson.finance.
const CAMPAIGNS = [
  board("01M72AN4VSH4FYYT9X7RF01P3N", [254, 906], [0, 237], 5),
  board("01M72AKHZ75KJSNS17AA9BJTJY", [8, 19], [0, 4], 1),
];

const exposure = (incidents: number, coverages = recorded.released): Exposure => ({
  incidents,
  coverages,
  horizon: 100,
  amountsMinor: recorded.amountsMinor,
  lossRatios: [],
});

describe("betaQuantile", () => {
  test("matches the closed forms of Beta(1, b), Beta(a, 1) and the arcsine law", () => {
    for (const q of [0.05, 0.5, 0.95, 0.99]) {
      expect(betaQuantile(q, 1, 1362)).toBeCloseTo(1 - (1 - q) ** (1 / 1362), 12);
      expect(betaQuantile(q, 7.5, 1)).toBeCloseTo(q ** (1 / 7.5), 10);
      expect(betaQuantile(q, 0.5, 0.5)).toBeCloseTo(Math.sin((Math.PI * q) / 2) ** 2, 10);
    }
  });

  test("matches quadrature on a non-integer posterior", () => {
    // The 0.95 quantile of Beta(7.25, 1400.5), by Simpson's rule on its density (200,000 panels).
    expect(betaQuantile(0.95, 7.25, 1400.5)).toBeCloseTo(0.0086335442, 8);
  });
});

describe("priorOf", () => {
  const prior = priorOf(CAMPAIGNS);

  test("pools the finished campaigns: μ = ASR · escape + amber, each a uniform-prior posterior mean", () => {
    expect(prior.campaigns).toEqual(CAMPAIGNS.map((c) => c.campaign));
    expect(prior.asr).toEqual({ k: 262, n: 925 });
    expect(prior.escape).toEqual({ k: 0, n: 241 });
    expect(prior.amber).toEqual({ k: 6, n: 925 });
    expect(prior.mu).toBeCloseTo((263 / 927) * (1 / 243) + 7 / 927, 12);
  });

  test("κ matches the prior's variance by the method of moments", () => {
    const m = (a: number, b: number) => [a / (a + b), (a * (a + 1)) / ((a + b) * (a + b + 1))];
    const [x, x2] = m(263, 664) as [number, number];
    const [y, y2] = m(1, 242) as [number, number];
    const [z, z2] = m(7, 920) as [number, number];
    const variance = x2 * y2 - (x * y) ** 2 + (z2 - z * z);
    expect(prior.kappa).toBeCloseTo((prior.mu * (1 - prior.mu)) / variance - 1, 6);
  });

  test("an unfinished or empty campaign adds nothing", () => {
    const running = { ...board("01M72AJAJGANNT4P3PBNECZ134", [3, 3], [3, 3], 0), complete: false };
    expect(priorOf([...CAMPAIGNS, running, board("x", [0, 0], [0, 0], 0)])).toEqual(prior);
  });

  test("without a finished campaign there is no prior", () => {
    expect(() => priorOf([])).toThrow(/campaign/);
    expect(() => priorOf([board("x", [0, 0], [0, 0], 0)])).toThrow(/campaign/);
  });
});

describe("grade", () => {
  const prior: Prior = priorOf(CAMPAIGNS);

  test("agent 351's recorded coverages: Bühlmann credibility and the 95 % credible upper bound", () => {
    const g = grade(prior, exposure(0), "351");
    const a = prior.kappa * prior.mu;
    const b = prior.kappa * (1 - prior.mu) + recorded.released;
    const z = recorded.released / (recorded.released + prior.kappa);
    expect(g.frequency.credibility_ppm).toBe(Math.round(z * 1e6));
    expect(g.frequency.mean_ppm).toBe(Math.round((a / (a + b)) * 1e6));
    expect(g.frequency.mean_ppm).toBe(Math.round((z * 0 + (1 - z) * prior.mu) * 1e6));
    expect(g.frequency.upper95_ppm).toBe(Math.ceil(betaQuantile(0.95, a, b) * 1e6));
    expect(g.grade).toBe("A");
  });

  test("incidents move the grade down and the premium and bond up; clean coverages move it back", () => {
    const clean = grade(prior, exposure(0), "351");
    const one = grade(prior, exposure(1), "351");
    const many = grade(prior, exposure(25), "351");
    expect(one.frequency.upper95_ppm).toBeGreaterThan(clean.frequency.upper95_ppm);
    expect(many.grade).not.toBe("A");
    expect(many.grade > one.grade).toBe(true);
    expect(many.premium.modelBps).toBeGreaterThan(one.premium.modelBps);
    expect(one.premium.modelBps).toBeGreaterThanOrEqual(clean.premium.modelBps);
    expect(many.bond.requiredMinor).toBeGreaterThanOrEqual(one.bond.requiredMinor);
    const recovered = grade(prior, exposure(1, 20 * recorded.released), "351");
    expect(recovered.frequency.upper95_ppm).toBeLessThan(one.frequency.upper95_ppm);
  });

  test("a new operator gets the prior alone, so a worse grade than a clean record", () => {
    const fresh = grade(prior, exposure(0, 0), "new");
    expect(fresh.frequency.credibility_ppm).toBe(0);
    expect(fresh.frequency.mean_ppm).toBe(Math.round(prior.mu * 1e6));
    expect(fresh.grade > grade(prior, exposure(0), "351").grade).toBe(true);
  });

  test("premium = EL(1 + θ) + c(ES99 - E[S]) / N in bps of the mean amount, never under the floor", () => {
    const g = grade(prior, exposure(3), "351");
    const mean = recorded.amountsMinor.reduce((s, a) => s + a, 0) / recorded.amountsMinor.length;
    const perPurchase =
      (g.frequency.mean_ppm / 1e6) * mean * 1.25 +
      (g.premium.costOfCapital * (g.loss.es99Minor - g.loss.expectedMinor)) / g.loss.horizon;
    expect(g.premium.modelBps).toBeCloseTo((perPurchase / mean) * 1e4, -1);
    expect(g.premium.costOfCapital).toBeCloseTo((0.06 * 30) / 365, 12);
    expect(g.premium.bps).toBe(Math.max(100, g.premium.modelBps));
    expect(g.loss.var99Minor).toBeLessThanOrEqual(g.loss.var995Minor);
    expect(g.loss.var99Minor).toBeLessThanOrEqual(g.loss.es99Minor);
    expect(g.bond.requiredMinor).toBe(
      Math.max(g.loss.es99Minor, g.loss.var995Minor, Math.max(...recorded.amountsMinor)),
    );
  });

  test("recorded loss ratios scale the severity", () => {
    const full = grade(prior, exposure(5), "351");
    const half = grade(prior, { ...exposure(5), lossRatios: [0.5] }, "351");
    expect(half.severity.lossRatio_ppm).toBe(500_000);
    expect(half.loss.expectedMinor).toBeLessThan(full.loss.expectedMinor);
  });

  test("the same inputs give the same grade, bit for bit", () => {
    expect(grade(prior, exposure(2), "351")).toEqual(grade(prior, exposure(2), "351"));
  });

  test("recomputes in under 50 ms", () => {
    grade(prior, exposure(0), "warm");
    const times = Array.from({ length: 20 }, (_, i) => {
      const t = performance.now();
      grade(prior, exposure(i % 5), `run-${i}`);
      return performance.now() - t;
    }).sort((a, b) => a - b);
    expect(times[10]).toBeLessThan(50);
  });
});
