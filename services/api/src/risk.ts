import {
  asc,
  type Db,
  desc,
  disputes,
  eq,
  inArray,
  isNotNull,
  mandates,
  operators,
  purchases,
  redTeamCampaigns,
  riskCalibrations,
  sql,
  verdicts,
} from "@keelson/db";
import {
  type Grade,
  grade,
  HORIZON_DAYS,
  type Prior,
  priorOf,
  type Scoreboard,
  score,
} from "@keelson/redteam";
import { ulid } from "ulid";
import { ledgerLines } from "./routes/redteam.ts";

/** A verdict with the operator at fault; Keelson's own faults (2) are its reserve's to price. */
const OPERATOR = 1;
/** Purchases whose coverage was locked and not released by a failure. */
const COVERED = [
  "COVERED",
  "CAPTURED",
  "DELIVERED",
  "SETTLED",
  "DISPUTED",
  "ATTRIBUTED",
  "SLASHED",
  "WARRANTY_PAID",
  "DEFENDED",
  "MERCHANT_LIABLE",
] as const;
/** The purchases the bond is priced for at least, whatever the operator's volume. */
const MIN_HORIZON = 100;
/** Covered amounts and loss ratios read, newest first. */
const MAX_SAMPLE = 5_000;
/** Today's flat rate, charged while the model has no finished campaign to calibrate from. */
const FLOOR_BPS = 100;

/** A calibration of the model: the red team's prior and the loss ratios verdicts recorded. */
export interface Calibration {
  id: string;
  createdAt: Date;
  prior: Prior;
  lossRatios: number[];
}

/** Rebuilds the prior from every finished red-team campaign and stores it. */
export async function calibrate(db: Db): Promise<Calibration | undefined> {
  const finished = await db
    .select()
    .from(redTeamCampaigns)
    .where(isNotNull(redTeamCampaigns.summary))
    .orderBy(asc(redTeamCampaigns.createdAt));
  const boards: Scoreboard[] = [];
  for (const c of finished) boards.push(score(await ledgerLines(db, c)));
  let prior: Prior;
  try {
    prior = priorOf(boards);
  } catch {
    return undefined;
  }
  const paid = await db
    .select({ paid: verdicts.amountMinor, amount: purchases.amountMinor })
    .from(verdicts)
    .innerJoin(disputes, eq(disputes.id, verdicts.disputeId))
    .innerJoin(purchases, eq(purchases.id, disputes.purchaseId))
    .where(eq(verdicts.liable, OPERATOR))
    .orderBy(desc(verdicts.createdAt))
    .limit(MAX_SAMPLE);
  const calibration = {
    id: ulid(),
    createdAt: new Date(),
    prior,
    lossRatios: paid.map((r) => Math.min(1, Number(r.paid) / Number(r.amount))),
  };
  await db.insert(riskCalibrations).values({
    id: calibration.id,
    createdAt: calibration.createdAt,
    body: { prior, lossRatios: calibration.lossRatios },
  });
  return calibration;
}

async function latest(db: Db): Promise<Calibration | undefined> {
  const [row] = await db
    .select()
    .from(riskCalibrations)
    .orderBy(desc(riskCalibrations.createdAt))
    .limit(1);
  if (!row) return calibrate(db);
  const body = row.body as Omit<Calibration, "id" | "createdAt">;
  return { id: row.id, createdAt: row.createdAt, ...body };
}

interface OperatorGrade extends Grade {
  v: "keelson.grade/1";
  agentId: string;
  computedAt: string;
  calibration: {
    id: string;
    at: string;
    campaigns: string[];
    mu_ppm: number;
    kappa: number;
  };
  evidence: {
    coverages: number;
    /** Verdicts with the operator at fault: what the grade counts. */
    incidents: {
      total: number;
      slashes: number;
      pool: number;
      uncollected: number;
      pending: number;
    };
  };
  /** Keelson's own faults on the operator's coverages, paid by its reserve: not in the grade. */
  reserve: { warranties: number };
  computeMs: number;
}

/** What changes an operator's grade: its record and the calibration. */
async function fingerprint(db: Db, agentId: bigint) {
  const covered = sql`${purchases.state} in (${sql.join(
    COVERED.map((s) => sql`${s}`),
    sql`, `,
  )})`;
  const [row] = await db
    .select({
      linked: sql<boolean>`exists (select 1 from ${operators} where ${operators.agentId} = ${agentId})`,
      coverages: sql<number>`count(*) filter (where ${covered})::int`,
      recent: sql<number>`count(*) filter (where ${covered} and ${purchases.createdAt} > now() - make_interval(days => ${HORIZON_DAYS}))::int`,
      incidents: sql<{
        total: number;
        slashes: number;
        pool: number;
        uncollected: number;
        pending: number;
        warranties: number;
        last: string | null;
      }>`(select json_build_object(
        'total', count(*) filter (where ${verdicts.liable} = 1),
        'slashes', count(*) filter (where ${verdicts.liable} = 1 and ${verdicts.paidBy} = 'chain'),
        'pool', count(*) filter (where ${verdicts.liable} = 1 and ${verdicts.paidBy} = 'violation-pool'),
        'uncollected', count(*) filter (where ${verdicts.liable} = 1 and ${verdicts.paidBy} = 'treasury'),
        'pending', count(*) filter (where ${verdicts.liable} = 1 and ${verdicts.paidBy} is null),
        'warranties', count(*) filter (where ${verdicts.liable} = 2),
        'last', max(greatest(${verdicts.createdAt}, ${verdicts.settledAt}))
      ) from ${verdicts}
        join ${disputes} on ${disputes.id} = ${verdicts.disputeId}
        join ${purchases} p on p.id = ${disputes.purchaseId}
        join ${mandates} m on m.id = p.mandate_id
        where m.operator_agent_id = ${agentId} and ${verdicts.liable} in (1, 2))`,
      calibration: sql<
        string | null
      >`(select ${riskCalibrations.id} from ${riskCalibrations} order by ${riskCalibrations.createdAt} desc limit 1)`,
    })
    .from(purchases)
    .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
    .where(eq(mandates.operatorAgentId, agentId));
  return row as NonNullable<typeof row>;
}

/** Covered amounts to draw losses from: the operator's, else everyone's, else its mandates' caps. */
async function amountsOf(db: Db, agentId: bigint): Promise<number[]> {
  const covered = inArray(purchases.state, [...COVERED]);
  const own = await db
    .select({ a: purchases.amountMinor })
    .from(purchases)
    .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
    .where(sql`${eq(mandates.operatorAgentId, agentId)} and ${covered}`)
    .orderBy(desc(purchases.createdAt))
    .limit(MAX_SAMPLE);
  if (own.length > 0) return own.map((r) => Number(r.a));
  const all = await db
    .select({ a: purchases.amountMinor })
    .from(purchases)
    .where(covered)
    .orderBy(desc(purchases.createdAt))
    .limit(MAX_SAMPLE);
  if (all.length > 0) return all.map((r) => Number(r.a));
  const caps = await db
    .select({ a: mandates.maxMinor })
    .from(mandates)
    .where(eq(mandates.operatorAgentId, agentId))
    .limit(MAX_SAMPLE);
  return caps.map((r) => Number(r.a)).filter((a) => a > 0);
}

export type GradeResult =
  | { kind: "graded"; grade: OperatorGrade }
  | { kind: "unknown" }
  | { kind: "uncalibrated" }
  | { kind: "unpriced" };

const cache = new Map<string, { key: string; grade: OperatorGrade }>();

/**
 * The operator's grade, recomputed only when its record or the calibration changed. The model
 * runs in `computeMs`; the record is read in one query.
 */
export async function gradeOf(db: Db, agentId: bigint): Promise<GradeResult> {
  const f = await fingerprint(db, agentId);
  if (!f.linked) return { kind: "unknown" };
  const key = JSON.stringify(f);
  const hit = cache.get(String(agentId));
  if (hit?.key === key) return { kind: "graded", grade: hit.grade };
  const calibration = await latest(db);
  if (!calibration) return { kind: "uncalibrated" };
  const amounts = await amountsOf(db, agentId);
  if (amounts.length === 0) return { kind: "unpriced" };
  const t = performance.now();
  const g = grade(
    calibration.prior,
    {
      // A purchase can carry several verdicts; at most one incident per coverage.
      incidents: Math.min(f.incidents.total, f.coverages),
      coverages: f.coverages,
      horizon: Math.max(f.recent, MIN_HORIZON),
      amountsMinor: amounts,
      lossRatios: calibration.lossRatios,
    },
    `${agentId}:${calibration.id}`,
  );
  const computeMs = Math.round((performance.now() - t) * 10) / 10;
  const { last: _last, warranties, ...incidents } = f.incidents;
  const out: OperatorGrade = {
    v: "keelson.grade/1",
    agentId: String(agentId),
    computedAt: new Date().toISOString(),
    calibration: {
      id: calibration.id,
      at: new Date(calibration.createdAt).toISOString(),
      campaigns: calibration.prior.campaigns,
      mu_ppm: Math.round(calibration.prior.mu * 1e6),
      kappa: calibration.prior.kappa,
    },
    evidence: { coverages: f.coverages, incidents },
    reserve: { warranties },
    ...g,
    computeMs,
  };
  // The calibration read may be newer than the fingerprint's; key on the one used.
  cache.set(String(agentId), {
    key: JSON.stringify({ ...f, calibration: calibration.id }),
    grade: out,
  });
  return { kind: "graded", grade: out };
}

/** The premium a new coverage of the operator pays, in basis points of its amount, 100 to 10,000. */
export async function premiumBps(db: Db, agentId: bigint): Promise<number> {
  try {
    const r = await gradeOf(db, agentId);
    const bps = r.kind === "graded" ? r.grade.premium.bps : FLOOR_BPS;
    return Number.isInteger(bps) && bps >= FLOOR_BPS && bps <= 10_000 ? bps : FLOOR_BPS;
  } catch {
    // A model that cannot price the operator never blocks its coverage: today's rate applies.
    return FLOOR_BPS;
  }
}
