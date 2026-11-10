import { createHash } from "node:crypto";
import { betaCdf, type Scoreboard } from "./scoreboard.ts";

/** Scenarios of the aggregate-loss simulation. */
const SCENARIOS = 20_000;
/** Safety loading on the expected loss. */
const THETA = 0.25;
/** The horizon priced: the bond carries the purchases of the next 30 days. */
export const HORIZON_DAYS = 30;
/** Solvency II's cost-of-capital rate, 6 % a year, for the capital held over the horizon. */
const COST_OF_CAPITAL = (0.06 * HORIZON_DAYS) / 365;
/** Today's flat rate: the premium never goes under it. */
const FLOOR_BPS = 100;
/** The contract refuses a premium above the covered amount. */
const MAX_BPS = 10_000;
/** Upper limits of the 95 % credible bound of the incident rate, per grade, in ppm. */
const GRADES = [
  ["A", 10_000],
  ["B", 20_000],
  ["C", 50_000],
  ["D", 100_000],
] as const;

export type TrustGrade = "A" | "B" | "C" | "D" | "F";

/** Lanczos (g = 7, n = 9) `ln Γ(x)` for `x > 0`. */
function lnGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const z = x - 1;
  let s = c[0] as number;
  for (let i = 1; i < 9; i++) s += (c[i] as number) / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(s);
}

/** The `q` quantile of Beta(a, b) for real `a, b > 0`, by bisection of the incomplete beta. */
export function betaQuantile(q: number, a: number, b: number): number {
  const lnB = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (mid === lo || mid === hi) break;
    if (betaCdf(mid, a, b, lnB) < q) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

interface Count {
  k: number;
  n: number;
}

/**
 * The global prior of an operator's incident rate per covered purchase, from the red team:
 * `μ = P(encounter) · ASR · escape + amber` with `P(encounter) = 1` (every purchase attacked),
 * each rate the mean of its uniform-prior posterior `Beta(k + 1, n - k + 1)`, and `κ` the
 * strength that gives `Beta(κμ, κ(1 - μ))` the same variance (method of moments).
 */
export interface Prior {
  mu: number;
  kappa: number;
  /** The finished campaigns pooled, in the order given. */
  campaigns: string[];
  asr: Count;
  escape: Count;
  amber: Count;
}

/** Mean and second moment of the posterior `Beta(k + 1, n - k + 1)`. */
function moments({ k, n }: Count): [number, number] {
  const a = k + 1;
  const s = n + 2;
  return [a / s, (a * (a + 1)) / (s * (s + 1))];
}

/** Pools the `all/all` rows of finished campaigns into the global prior. */
export function priorOf(boards: readonly Scoreboard[]): Prior {
  const counts = { asr: { k: 0, n: 0 }, escape: { k: 0, n: 0 }, amber: { k: 0, n: 0 } };
  const campaigns: string[] = [];
  for (const b of boards) {
    const row = b.rows.find((r) => r.backbone === "all" && r.split === "all");
    if (!b.complete || !row || row.asr.n === 0) continue;
    campaigns.push(b.campaign);
    for (const key of ["asr", "escape", "amber"] as const) {
      counts[key].k += row[key].k;
      counts[key].n += row[key].n;
    }
  }
  if (campaigns.length === 0) throw new Error("no finished red-team campaign to build the prior");
  const [x, x2] = moments(counts.asr);
  const [y, y2] = moments(counts.escape);
  const [z, z2] = moments(counts.amber);
  const mu = x * y + z;
  const variance = x2 * y2 - (x * y) ** 2 + (z2 - z * z);
  return { mu, kappa: (mu * (1 - mu)) / variance - 1, campaigns, ...counts };
}

/** What an operator's covered purchases recorded. */
export interface Exposure {
  /** Verdicts against its coverages with the operator or Keelson at fault. */
  incidents: number;
  /** Its covered purchases. */
  coverages: number;
  /** The purchases the bond carries over the horizon priced. */
  horizon: number;
  /** Covered amounts, in minor units, that a loss is drawn from; each is within its mandate's cap. */
  amountsMinor: readonly number[];
  /** Paid share of the covered amount in recorded verdicts; a loss is the whole amount without one. */
  lossRatios: readonly number[];
}

export interface Grade {
  grade: TrustGrade;
  frequency: {
    alpha: number;
    beta: number;
    /** Bühlmann's `Z = n / (n + κ)`: the weight of the operator's own record. */
    credibility_ppm: number;
    mean_ppm: number;
    /** The one-sided 95 % credible upper bound the grade reads. */
    upper95_ppm: number;
  };
  severity: { meanMinor: number; maxMinor: number; lossRatio_ppm: number };
  /** The aggregate loss over the horizon, by Monte Carlo with the rate's uncertainty. */
  loss: {
    horizon: number;
    scenarios: number;
    expectedMinor: number;
    var99Minor: number;
    es99Minor: number;
    var995Minor: number;
  };
  /** `EL(1 + θ) + c(ES99 - E[S]) / N` per purchase, in basis points of the mean amount. */
  premium: {
    bps: number;
    modelBps: number;
    floorBps: number;
    theta: number;
    costOfCapital: number;
  };
  /** `max(ES99, VaR99.5, the largest coverage)`. */
  bond: { requiredMinor: number };
}

/** MurmurHash3's 32-bit finalizer. */
function fmix(h: number): number {
  let x = h >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * Counter-based uniforms in (0, 1): draw `j` of scenario `i` on `stream` is the same whatever the
 * rate, so the losses of two grades of one operator differ only by their rates (common random
 * numbers), and a grade is reproducible from its inputs.
 */
function uniforms(seed: string): (i: number, j: number, stream: number) => number {
  const key = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return (i, j, stream) =>
    (fmix(key ^ fmix(Math.imul(i, 0x9e3779b1) ^ fmix(Math.imul(j, 0x85ebca77) + stream))) + 0.5) /
    2 ** 32;
}

/**
 * The posterior's quantiles at `(i + 0.5) / count`: the rate is stratified across scenarios, by
 * inverting the incomplete beta tabulated on a grid up to its 1 - 1e-6 quantile.
 */
function stratified(alpha: number, beta: number, count: number): Float64Array {
  const grid = 2_048;
  const lnB = lnGamma(alpha) + lnGamma(beta) - lnGamma(alpha + beta);
  const top = betaQuantile(1 - 1e-6, alpha, beta);
  const cdf = new Float64Array(grid + 1);
  for (let g = 1; g <= grid; g++) cdf[g] = betaCdf((top * g) / grid, alpha, beta, lnB);
  const out = new Float64Array(count);
  let g = 1;
  for (let i = 0; i < count; i++) {
    const q = (i + 0.5) / count;
    while (g < grid && (cdf[g] as number) < q) g++;
    const lo = cdf[g - 1] as number;
    const hi = cdf[g] as number;
    const t = hi > lo ? Math.min(1, (q - lo) / (hi - lo)) : 1;
    out[i] = (top * (g - 1 + t)) / grid;
  }
  return out;
}

/** The `u` quantile of Binomial(n, p) by inversion; a normal approximation past 500 expected events. */
function binomial(n: number, p: number, u: number, v: number): number {
  if (p <= 0 || n === 0) return 0;
  const mean = n * p;
  if (mean > 500) {
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.min(n, Math.max(0, Math.round(mean + Math.sqrt(mean * (1 - p)) * z)));
  }
  const r = p / (1 - p);
  let f = (1 - p) ** n;
  let x = u;
  let k = 0;
  while (x > f && k < n) {
    x -= f;
    f *= (r * (n - k)) / (k + 1);
    k++;
  }
  return k;
}

const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/**
 * An operator's trust grade, premium and bond: its incidents update the prior in closed form
 * (`α = κμ + k`, `β = κ(1 - μ) + n - k`), the grade reads the posterior's 95 % credible upper
 * bound, and the premium and bond read a Monte Carlo of the aggregate loss over the horizon,
 * drawing the rate from the posterior and each loss from the recorded amounts and loss ratios.
 */
export function grade(prior: Prior, exposure: Exposure, seed: string): Grade {
  const { incidents: k, coverages: n, horizon } = exposure;
  if (exposure.amountsMinor.length === 0) throw new Error("no covered amount to draw losses from");
  // Sorted, so that the draws depend on the recorded values and not on the order they were read in.
  const amounts = [...exposure.amountsMinor].sort((a, b) => a - b);
  const ratios =
    exposure.lossRatios.length > 0 ? [...exposure.lossRatios].sort((a, b) => a - b) : [1];
  const alpha = prior.kappa * prior.mu + k;
  const beta = prior.kappa * (1 - prior.mu) + n - k;
  const p = alpha / (alpha + beta);
  const upper = betaQuantile(0.95, alpha, beta);
  const severity = mean(amounts) * mean(ratios);

  const u = uniforms(seed);
  const rates = stratified(alpha, beta, SCENARIOS);
  const totals = new Float64Array(SCENARIOS);
  for (let i = 0; i < SCENARIOS; i++) {
    const losses = binomial(horizon, rates[i] as number, u(i, 0, 0), u(i, 0, 1));
    let s = 0;
    for (let j = 1; j <= losses; j++) {
      s +=
        (amounts[Math.floor(u(i, j, 0) * amounts.length)] as number) *
        (ratios[Math.floor(u(i, j, 1) * ratios.length)] as number);
    }
    totals[i] = s;
  }
  totals.sort();
  const at = (q: number) => totals[Math.ceil(q * SCENARIOS) - 1] as number;
  const tail = totals.subarray(Math.ceil(0.99 * SCENARIOS) - 1);
  const expected = totals.reduce((s, x) => s + x, 0) / SCENARIOS;
  const es99 = tail.reduce((s, x) => s + x, 0) / tail.length;

  const perPurchase = p * severity * (1 + THETA) + (COST_OF_CAPITAL * (es99 - expected)) / horizon;
  const modelBps = Math.ceil((perPurchase / mean(amounts)) * 10_000);
  const upper95 = Math.ceil(upper * 1e6);
  const es99Minor = Math.ceil(es99);
  const var995Minor = Math.ceil(at(0.995));
  return {
    grade: GRADES.find(([, limit]) => upper95 <= limit)?.[0] ?? "F",
    frequency: {
      alpha,
      beta,
      credibility_ppm: Math.round((n / (n + prior.kappa)) * 1e6),
      mean_ppm: Math.round(p * 1e6),
      upper95_ppm: upper95,
    },
    severity: {
      meanMinor: Math.round(severity),
      maxMinor: Math.max(...amounts),
      lossRatio_ppm: Math.round(mean(ratios) * 1e6),
    },
    loss: {
      horizon,
      scenarios: SCENARIOS,
      expectedMinor: Math.round(expected),
      var99Minor: Math.ceil(at(0.99)),
      es99Minor,
      var995Minor,
    },
    premium: {
      bps: Math.min(MAX_BPS, Math.max(FLOOR_BPS, modelBps)),
      modelBps,
      floorBps: FLOOR_BPS,
      theta: THETA,
      costOfCapital: COST_OF_CAPITAL,
    },
    bond: { requiredMinor: Math.max(es99Minor, var995Minor, Math.max(...amounts)) },
  };
}
