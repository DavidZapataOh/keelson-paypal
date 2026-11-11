import { CHAIN_IDS } from "@keelson/core/eip712";
import {
  agentConnections,
  agentStops,
  and,
  type Db,
  eq,
  inArray,
  isNotNull,
  isNull,
  mandates,
  ne,
  oauthConsent,
  oauthRefreshToken,
  purchaseHolds,
  purchases,
  sql,
} from "@keelson/db";
import {
  LOG_ORIGINS,
  LOG_VKEYS,
  LogClient,
  leafHash,
  stopLeafBytes,
  verifyProof,
} from "@keelson/log";
import type { Logger } from "pino";
import type { RedisClientType } from "redis";
import { ulid } from "ulid";
import { publishEvent } from "./events.ts";
import type { LogConfig } from "./log/append.ts";
import type { PayPalDeps } from "./paypal.ts";
import { principalChannel } from "./principal.ts";
import { REVOCABLE, revokeMandate } from "./routes/revoke.ts";
import { stoppedKey } from "./stopped.ts";

export interface StopDeps {
  db: Db;
  kv: RedisClientType;
  log: Logger;
  paypal?: PayPalDeps;
  tlog?: LogConfig;
}

type Money = { currency: string; minor: string }[];

export interface StopRecord {
  id: string;
  revoked: number;
  /** What PayPal released when the stop voided the holds, per currency. */
  released: Money;
  /** Holds still backing a countersigned purchase: released once it is captured. */
  releasing: Money;
  /** Hex of the stopped mandates' hashes, which the stop leaf commits to. */
  mandateHashes: string[];
  /** The stop leaf's index in each log origin; empty until it is logged. */
  logIndexes: Record<string, string>;
  logged: boolean;
  createdAt: string;
}

type Row = typeof agentStops.$inferSelect;

const toRecord = (row: Row): StopRecord => ({
  id: row.id,
  revoked: row.revoked,
  released: row.released,
  releasing: row.releasing,
  mandateHashes: row.mandateHashes,
  logIndexes: row.logIndexes,
  logged: row.loggedAt !== null,
  createdAt: row.createdAt.toISOString(),
});

/** Whether the user stopped every agent after this mandate was stored. */
export async function stoppedSince(
  db: Pick<Db, "select">,
  userId: string,
  since: Date,
): Promise<boolean> {
  const [hit] = await db
    .select({ id: agentStops.id })
    .from(agentStops)
    .where(and(eq(agentStops.userId, userId), sql`${agentStops.createdAt} >= ${since}`))
    .limit(1);
  return hit !== undefined;
}

const sum = (into: Map<string, bigint>, currency: string, minor: bigint) =>
  into.set(currency, (into.get(currency) ?? 0n) + minor);
const money = (m: Map<string, bigint>): Money =>
  [...m]
    .filter(([, minor]) => minor > 0n)
    .map(([currency, minor]) => ({ currency, minor: minor.toString() }));

/**
 * Stops every agent of the user at once. The stop is stored first, so from this instant no
 * mandate stored before it is countersigned; then every live mandate is flagged, every request
 * denied and every OAuth grant revoked; then each hold is voided. The stop leaf is appended once
 * no purchase of the stopped mandates can still be logged (see {@link finishStops}).
 */
export async function stopAgents(deps: StopDeps, userId: string): Promise<StopRecord> {
  const { db } = deps;
  const id = ulid();
  await db.insert(agentStops).values({ id, userId });
  await deps.kv.set(stoppedKey(userId), String(Math.floor(Date.now() / 1000))).catch(() => {});

  const rows = await flagLive(db, userId);
  await db
    .update(agentConnections)
    .set({ disconnectedAt: new Date() })
    .where(and(eq(agentConnections.userId, userId), isNull(agentConnections.disconnectedAt)));
  await db
    .update(agentConnections)
    .set({ state: "DENIED", decidedAt: new Date() })
    .where(and(eq(agentConnections.userId, userId), eq(agentConnections.state, "PENDING")));
  // Refresh tokens and consents end here; access tokens are refused by their issue time.
  await db
    .update(oauthRefreshToken)
    .set({ revoked: new Date() })
    .where(and(eq(oauthRefreshToken.userId, userId), isNull(oauthRefreshToken.revoked)));
  await db.delete(oauthConsent).where(eq(oauthConsent.userId, userId));
  // Again, so that a token refreshed while the grants were being revoked is refused too.
  await deps.kv.set(stoppedKey(userId), String(Math.floor(Date.now() / 1000))).catch(() => {});

  const released = new Map<string, bigint>();
  const releasing = new Map<string, bigint>();
  for (const m of rows) {
    const held = await heldBy(db, m);
    let ended: "REVOKED" | "REVOKING" = "REVOKING";
    try {
      ended = await revokeMandate(deps, m);
    } catch (err) {
      // The sweeper voids a hold whose revoke is requested; countersigns are already refused.
      deps.log.warn({ err, mandateId: m.id }, "hold not voided on stop; the sweeper retries");
    }
    if (held > 0n) sum(ended === "REVOKED" ? released : releasing, m.currency, held);
  }

  const mandateHashes = rows.flatMap((m) =>
    m.mandateHash ? [Buffer.from(m.mandateHash).toString("hex")] : [],
  );
  const leaf =
    mandateHashes.length > 0
      ? Buffer.from(
          stopLeafBytes({
            stopId: id,
            issuedAt: Math.floor(Date.now() / 1000),
            mandateHashes: mandateHashes.map((h) => Buffer.from(h, "hex")),
          }),
        )
      : null;
  const [row] = await db
    .update(agentStops)
    .set({
      mandateHashes,
      revoked: rows.length,
      released: money(released),
      releasing: money(releasing),
      leaf,
      // A stop that ended no signed mandate has nothing for the log to order.
      ...(leaf ? {} : { loggedAt: new Date() }),
    })
    .where(eq(agentStops.id, id))
    .returning();
  if (!row) throw new Error("the stop was not stored");
  const done = await finishStop(deps, row);
  await publishEvent(deps, principalChannel({ kind: "user", subject: userId }, "agents"), id, {
    type: "agents.stopped",
    stopId: id,
    revoked: rows.length,
    released: done.released,
    releasing: done.releasing,
    logIndexes: done.logIndexes,
  });
  return done;
}

/** Flags every live mandate of the user; a second pass catches one stored while the first ran. */
async function flagLive(db: Db, userId: string) {
  const flag = () =>
    db
      .update(mandates)
      .set({ revokeRequestedAt: sql`coalesce(${mandates.revokeRequestedAt}, now())` })
      .where(
        and(
          eq(mandates.userId, userId),
          inArray(mandates.state, [...REVOCABLE]),
          isNull(mandates.revokeRequestedAt),
        ),
      )
      .returning();
  const first = await flag();
  return [...first, ...(await flag())];
}

/**
 * What PayPal holds for the mandate beyond its countersigned purchases: what is left of a
 * mandate's hold, or its per-purchase holds no purchase was countersigned under.
 */
async function heldBy(db: Db, m: typeof mandates.$inferSelect): Promise<bigint> {
  const [open] = await db
    .select({ minor: sql<string>`coalesce(sum(${purchases.amountMinor}), 0)::text` })
    .from(purchases)
    .where(
      and(
        eq(purchases.mandateId, m.id),
        inArray(purchases.state, ["EVALUATING", "COUNTERSIGNED", "LOGGED", "COVERED"]),
      ),
    );
  if (m.holdMode !== "per_purchase") {
    if (m.state !== "ACTIVE" || !m.paypalAuthorizationId) return 0n;
    const left = m.remainingMinor - BigInt(open?.minor ?? "0");
    return left > 0n ? left : 0n;
  }
  const [unused] = await db
    .select({ minor: sql<string>`coalesce(sum(${purchaseHolds.amountMinor}), 0)::text` })
    .from(purchaseHolds)
    .where(
      and(
        eq(purchaseHolds.mandateId, m.id),
        eq(purchaseHolds.state, "AUTHORIZED"),
        sql`not exists (select 1 from ${purchases} where ${purchases.id} = ${purchaseHolds.requestId})`,
      ),
    );
  return BigInt(unused?.minor ?? "0");
}

/**
 * Appends the stop's leaf to every log origin that holds, or may hold, an Alibi of its mandates,
 * once none of their purchases can still be logged: from the leaf's index on, no Alibi leaf
 * carries one of its mandate hashes. Appending the same leaf again returns the same index.
 */
async function finishStop(
  deps: Pick<StopDeps, "db" | "log" | "tlog">,
  row: Row,
): Promise<StopRecord> {
  if (row.loggedAt || !row.leaf || !deps.tlog) return toRecord(row);
  const { db } = deps;
  const stopped = await db
    .select({ id: mandates.id })
    .from(mandates)
    .where(
      inArray(
        mandates.mandateHash,
        row.mandateHashes.map((h) => Buffer.from(h, "hex")),
      ),
    );
  const ids = stopped.map((m) => m.id);
  const [unlogged] = await db
    .select({ id: purchases.id })
    .from(purchases)
    .where(
      and(
        inArray(purchases.mandateId, ids),
        isNull(purchases.logIndex),
        ne(purchases.state, "FAILED"),
      ),
    )
    .limit(1);
  if (unlogged) return toRecord(row);
  const chains = await db
    .selectDistinct({ chainId: purchases.chainId })
    .from(purchases)
    .where(and(inArray(purchases.mandateId, ids), isNotNull(purchases.chainId)));
  const origins = [
    ...new Set([
      LOG_ORIGINS[CHAIN_IDS.arbitrumSepolia] as string,
      ...chains.flatMap((c) =>
        c.chainId && LOG_ORIGINS[c.chainId] ? [LOG_ORIGINS[c.chainId] as string] : [],
      ),
    ]),
  ];
  const indexes = { ...row.logIndexes };
  for (const origin of origins.filter((o) => !(o in indexes))) {
    try {
      const client = new LogClient(deps.tlog.url, deps.tlog.token, origin, deps.tlog.timeoutMs);
      const result = await client.stop(row.leaf);
      const vkeys = deps.tlog.vkeys?.[origin] ?? LOG_VKEYS[origin];
      if (!vkeys || verifyProof(result.proof, leafHash(row.leaf), vkeys).index !== result.index) {
        throw new Error("the log's proof does not verify");
      }
      indexes[origin] = result.index.toString();
    } catch (err) {
      deps.log.warn({ err, stopId: row.id, origin }, "stop not logged yet; the resumer retries");
    }
  }
  const all = origins.every((o) => o in indexes);
  const [updated] = await db
    .update(agentStops)
    .set({ logIndexes: indexes, ...(all ? { loggedAt: new Date() } : {}) })
    .where(eq(agentStops.id, row.id))
    .returning();
  return toRecord(updated ?? row);
}

/**
 * Called by the resumer: revokes any live mandate a stop did not see although it was stored
 * before it, and logs the stops whose mandates' purchases are all logged.
 */
export async function finishStops(deps: StopDeps): Promise<number> {
  const { db } = deps;
  const missed = await db
    .select({ mandate: mandates })
    .from(mandates)
    .innerJoin(
      agentStops,
      and(
        eq(agentStops.userId, mandates.userId),
        sql`${mandates.createdAt} <= ${agentStops.createdAt}`,
      ),
    )
    .where(and(inArray(mandates.state, [...REVOCABLE]), isNull(mandates.revokeRequestedAt)))
    .limit(20);
  for (const { mandate } of missed) {
    await db
      .update(mandates)
      .set({ revokeRequestedAt: sql`coalesce(${mandates.revokeRequestedAt}, now())` })
      .where(eq(mandates.id, mandate.id));
    await revokeMandate(deps, mandate).catch((err: unknown) =>
      deps.log.warn({ err, mandateId: mandate.id }, "missed mandate not revoked yet"),
    );
  }
  const pending = await db
    .select()
    .from(agentStops)
    .where(isNull(agentStops.loggedAt))
    .orderBy(agentStops.createdAt)
    .limit(20);
  let logged = 0;
  for (const row of pending) if ((await finishStop(deps, row)).logged) logged++;
  return missed.length + logged;
}

/** The user's stops, newest first. */
export async function userStops(db: Db, userId: string): Promise<StopRecord[]> {
  const rows = await db
    .select()
    .from(agentStops)
    .where(eq(agentStops.userId, userId))
    .orderBy(sql`${agentStops.createdAt} desc`)
    .limit(20);
  return rows.map(toRecord);
}
