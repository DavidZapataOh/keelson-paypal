import {
  and,
  type Db,
  desc,
  disputes,
  eq,
  inArray,
  lt,
  mandates,
  redTeamCampaigns,
  session,
  sql,
  transition,
  user,
} from "@keelson/db";
import type { Logger } from "pino";
import type { RedisClientType } from "redis";
import { type HoldDeps, voidHold } from "./hold/maintenance.ts";

/**
 * Judges older than this are closed by the nightly reset.
 * @internal
 */
export const JUDGE_TTL_MS = 12 * 3_600_000;
/** Mandate compiles a judge may run: each one pays for three model calls. */
export const JUDGE_COMPILES = 5;
/** New judges a day, over every address. */
const JUDGES_PER_DAY = 200;

/** Whether a judge opened at `createdAt` has outlived its tenant. */
export const judgeExpired = (createdAt: Date, now = Date.now()): boolean =>
  now - new Date(createdAt).getTime() >= JUDGE_TTL_MS;

/** Whether the user is a Judge Mode tenant that has not expired. */
export async function isJudge(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ isAnonymous: user.isAnonymous, createdAt: user.createdAt })
    .from(user)
    .where(eq(user.id, userId));
  return row?.isAnonymous === true && !judgeExpired(row.createdAt);
}

const day = () => new Date().toISOString().slice(0, 10);

/** Counts one more judge today; false once {@link JUDGES_PER_DAY} were opened. */
export async function admitJudge(kv: RedisClientType): Promise<boolean> {
  const key = `judge:opened:${day()}`;
  const [count] = await kv
    .multi()
    .incr(key)
    .expire(key, 2 * 86_400)
    .exec();
  return Number(count) <= JUDGES_PER_DAY;
}

/** Counts one more compile by the judge; false past {@link JUDGE_COMPILES}. */
export async function admitJudgeCompile(kv: RedisClientType, userId: string): Promise<boolean> {
  const key = `judge:compiles:${userId}`;
  const [count] = await kv
    .multi()
    .incr(key)
    .expire(key, JUDGE_TTL_MS / 1000, "NX")
    .exec();
  return Number(count) <= JUDGE_COMPILES;
}

/**
 * The newest real rows the tour walks through: the demo operator's latest mandate with a captured
 * purchase that has an Alibi, signed by one of Keelson's own test buyers (an `example.test`
 * address the agent runs create) so no shopper's mandate is shown, the latest sandbox dispute with a verdict, and the latest finished
 * red-team campaign.
 */
export async function tourSeed(db: Db, agentId: bigint | undefined) {
  const [bought] = await db
    .execute<{ mandate_id: string }>(sql`
    select p.mandate_id from purchases p
    join mandates m on m.id = p.mandate_id
    join alibis a on a.purchase_id = p.id
    join "user" u on u.id = m.user_id
    where p.state = 'CAPTURED' and not u.is_anonymous and u.email like '%@example.test' ${agentId === undefined ? sql`` : sql`and m.operator_agent_id = ${agentId.toString()}`}
    order by p.created_at desc limit 1`)
    .then((r) => r.rows);
  const [dispute] = await db
    .select({ id: disputes.id })
    .from(disputes)
    .where(inArray(disputes.state, ["ATTRIBUTED", "RESOLVED"]))
    .orderBy(desc(disputes.updatedAt))
    .limit(1);
  const [campaign] = await db
    .select({ id: redTeamCampaigns.id })
    .from(redTeamCampaigns)
    .where(sql`${redTeamCampaigns.finishedAt} is not null`)
    .orderBy(desc(redTeamCampaigns.finishedAt))
    .limit(1);
  return {
    mandateId: bought?.mandate_id ?? null,
    disputeId: dispute?.id ?? null,
    campaignId: campaign?.id ?? null,
  };
}

/**
 * Closes every judge opened before `now - JUDGE_TTL_MS`: revokes the mandates it left open
 * (voiding their PayPal holds), deletes its sessions, and deletes the judge itself when it owns
 * no mandate (its passkeys and accounts go with it). Mandates and their purchases stay: their
 * Alibis are already in the public log.
 */
export async function resetJudges(
  deps: { db: Db; kv: RedisClientType; log: Logger; paypal?: HoldDeps["paypal"] },
  now = new Date(),
): Promise<{ closed: number; deleted: number; revoked: number; waiting: number }> {
  const { db } = deps;
  const stale = await db
    .select({ id: user.id })
    .from(user)
    .where(
      and(eq(user.isAnonymous, true), lt(user.createdAt, new Date(now.getTime() - JUDGE_TTL_MS))),
    );
  if (stale.length === 0) return { closed: 0, deleted: 0, revoked: 0, waiting: 0 };
  const ids = stale.map((u) => u.id);

  let revoked = 0;
  let waiting = 0;
  const open = await db
    .select({ id: mandates.id, state: mandates.state })
    .from(mandates)
    .where(
      and(
        inArray(mandates.userId, ids),
        inArray(mandates.state, ["SIGNED", "HOLD_PENDING", "ACTIVE"]),
      ),
    );
  for (const m of open) {
    await db
      .update(mandates)
      .set({ revokeRequestedAt: sql`coalesce(${mandates.revokeRequestedAt}, now())` })
      .where(eq(mandates.id, m.id));
    if (m.state === "SIGNED") {
      if (await transition(db, "mandates", m.id, "SIGNED", "REVOKED")) revoked++;
    } else if (deps.paypal) {
      const r = await voidHold({ ...deps, paypal: deps.paypal }, m.id, "REVOKED", now).catch(
        (err: unknown) => {
          deps.log.warn({ err, mandateId: m.id }, "judge mandate not voided");
          return "waiting" as const;
        },
      );
      if (r === "waiting") waiting++;
      else revoked++;
    } else {
      waiting++;
    }
  }

  await db.delete(session).where(inArray(session.userId, ids));
  const owners = new Set(
    (
      await db
        .selectDistinct({ userId: mandates.userId })
        .from(mandates)
        .where(inArray(mandates.userId, ids))
    ).map((r) => r.userId),
  );
  const unowned = ids.filter((id) => !owners.has(id));
  if (unowned.length > 0) await db.delete(user).where(inArray(user.id, unowned));
  return { closed: ids.length, deleted: unowned.length, revoked, waiting };
}
