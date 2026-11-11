import { CHAIN_IDS } from "@keelson/core/eip712";
import {
  agentConnections,
  agentStops,
  and,
  type Db,
  eq,
  inArray,
  isNull,
  mandates,
  oauthAccessToken,
  oauthConsent,
  oauthRefreshToken,
  purchaseHolds,
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

export interface StopDeps {
  db: Db;
  kv: RedisClientType;
  log: Logger;
  paypal?: PayPalDeps;
  tlog?: LogConfig;
}

export interface StopRecord {
  id: string;
  revoked: number;
  /** What PayPal held for the stopped mandates, per currency, now being released. */
  released: { currency: string; minor: string }[];
  /** Hex of the stopped mandates' hashes, which the stop leaf commits to. */
  mandateHashes: string[];
  logIndex: string | null;
  createdAt: string;
}

const toRecord = (row: typeof agentStops.$inferSelect): StopRecord => ({
  id: row.id,
  revoked: row.revoked,
  released: row.released,
  mandateHashes: row.mandateHashes,
  logIndex: row.logIndex?.toString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Appends the stop's leaf to the sandbox Alibi log and records its index once the proof verifies.
 * Appending the same stop again returns the same index, so a failed append is retried safely.
 */
export async function logStop(
  deps: Pick<StopDeps, "db" | "log" | "tlog">,
  row: typeof agentStops.$inferSelect,
): Promise<bigint | null> {
  if (row.logIndex !== null) return row.logIndex;
  if (!deps.tlog) return null;
  const origin = LOG_ORIGINS[CHAIN_IDS.arbitrumSepolia] as string;
  try {
    const client = new LogClient(deps.tlog.url, deps.tlog.token, origin, deps.tlog.timeoutMs);
    const result = await client.stop(row.leaf);
    const vkeys = deps.tlog.vkeys?.[origin] ?? LOG_VKEYS[origin];
    if (!vkeys || verifyProof(result.proof, leafHash(row.leaf), vkeys).index !== result.index) {
      throw new Error("the log's proof does not verify");
    }
    await deps.db
      .update(agentStops)
      .set({ logIndex: result.index })
      .where(and(eq(agentStops.id, row.id), isNull(agentStops.logIndex)));
    return result.index;
  } catch (err) {
    deps.log.warn({ err, stopId: row.id }, "stop not logged yet; read it again to retry");
    return null;
  }
}

/**
 * Stops every agent of the user at once: countersigns are refused from this instant, every live
 * mandate is revoked and its PayPal holds voided, every open request is denied, every agent's
 * OAuth grant is revoked, and the stop is logged as a leaf in the Alibi log.
 */
export async function stopAgents(deps: StopDeps, userId: string): Promise<StopRecord> {
  const { db } = deps;
  const id = ulid();
  // Every countersign stops at once; the holds are released one by one after. A second pass
  // catches a mandate stored while the first one ran.
  const flag = () =>
    db
      .update(mandates)
      .set({ revokeRequestedAt: sql`coalesce(${mandates.revokeRequestedAt}, now())` })
      .where(and(eq(mandates.userId, userId), inArray(mandates.state, [...REVOCABLE])))
      .returning();
  const first = await flag();
  const later = (await flag()).filter((r) => !first.some((f) => f.id === r.id));
  const rows = [...first, ...later];

  const held = new Map<string, bigint>();
  const add = (currency: string, minor: bigint) =>
    held.set(currency, (held.get(currency) ?? 0n) + minor);
  for (const m of rows) {
    if (m.state === "ACTIVE" && m.holdMode !== "per_purchase" && m.paypalAuthorizationId) {
      add(m.currency, m.remainingMinor);
    }
  }
  const perPurchase = rows.filter((m) => m.holdMode === "per_purchase").map((m) => m.id);
  if (perPurchase.length > 0) {
    for (const h of await db
      .select({ currency: purchaseHolds.currency, minor: purchaseHolds.amountMinor })
      .from(purchaseHolds)
      .where(
        and(inArray(purchaseHolds.mandateId, perPurchase), eq(purchaseHolds.state, "AUTHORIZED")),
      )) {
      add(h.currency, h.minor);
    }
  }

  const mandateHashes = rows.flatMap((m) =>
    m.mandateHash ? [Buffer.from(m.mandateHash).toString("hex")] : [],
  );
  const leaf = stopLeafBytes({
    stopId: id,
    issuedAt: Math.floor(Date.now() / 1000),
    mandateHashes: mandateHashes.map((h) => Buffer.from(h, "hex")),
  });
  const [row] = await db
    .insert(agentStops)
    .values({
      id,
      userId,
      mandateHashes,
      revoked: rows.length,
      released: [...held].map(([currency, minor]) => ({ currency, minor: minor.toString() })),
      leaf: Buffer.from(leaf),
    })
    .returning();
  if (!row) throw new Error("the stop was not stored");

  for (const m of rows) {
    try {
      await revokeMandate(deps, m);
    } catch (err) {
      // The sweeper voids a hold whose revoke is requested; countersigns are already refused.
      deps.log.warn({ err, mandateId: m.id }, "hold not voided on stop; the sweeper retries");
    }
  }
  await db
    .update(agentConnections)
    .set({ disconnectedAt: new Date() })
    .where(and(eq(agentConnections.userId, userId), isNull(agentConnections.disconnectedAt)));
  await db
    .update(agentConnections)
    .set({ state: "DENIED", decidedAt: new Date() })
    .where(and(eq(agentConnections.userId, userId), eq(agentConnections.state, "PENDING")));
  // Agents connected through OAuth lose their grants: they must ask the user to connect again.
  await db
    .update(oauthRefreshToken)
    .set({ revoked: new Date() })
    .where(and(eq(oauthRefreshToken.userId, userId), isNull(oauthRefreshToken.revoked)));
  await db
    .update(oauthAccessToken)
    .set({ revoked: new Date() })
    .where(and(eq(oauthAccessToken.userId, userId), isNull(oauthAccessToken.revoked)));
  await db.delete(oauthConsent).where(eq(oauthConsent.userId, userId));

  const logIndex = await logStop(deps, row);
  await publishEvent(deps, principalChannel({ kind: "user", subject: userId }, "agents"), id, {
    type: "agents.stopped",
    stopId: id,
    revoked: rows.length,
    released: row.released,
    logIndex: logIndex?.toString() ?? null,
  });
  return { ...toRecord(row), logIndex: logIndex?.toString() ?? null };
}

/** The user's stops, newest first; a stop not logged yet is logged again on the way. */
export async function userStops(
  deps: Pick<StopDeps, "db" | "log" | "tlog">,
  userId: string,
): Promise<StopRecord[]> {
  const rows = await deps.db
    .select()
    .from(agentStops)
    .where(eq(agentStops.userId, userId))
    .orderBy(sql`${agentStops.createdAt} desc`)
    .limit(20);
  const out: StopRecord[] = [];
  for (const r of rows) {
    const logIndex = await logStop(deps, r);
    out.push({ ...toRecord(r), logIndex: logIndex?.toString() ?? null });
  }
  return out;
}

/** Whether the user stopped every agent after this mandate was stored. */
export async function stoppedSince(db: Db, userId: string, since: Date): Promise<boolean> {
  const [hit] = await db
    .select({ id: agentStops.id })
    .from(agentStops)
    .where(and(eq(agentStops.userId, userId), sql`${agentStops.createdAt} >= ${since}`))
    .limit(1);
  return hit !== undefined;
}
