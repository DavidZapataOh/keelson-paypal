import { randomInt } from "node:crypto";
import { and, type Db, eq, inArray, isNotNull, mandates, statusLists } from "@keelson/db";
import { encodeStatusList, STATUS_SIZE, STATUS_URI, statusBits } from "@keelson/mandate";
import type { Logger } from "pino";
import type { TeeConfig } from "./tee/signers.ts";

/** A token older than this is signed again before a countersign carries it (the TEEs accept 300 s). */
const REFRESH_MS = 240_000;

export interface StatusListDeps {
  db: Db;
  log: Logger;
  tee: Pick<TeeConfig, "client">;
}

/**
 * An index of the status list no mandate holds, drawn uniformly (draft-ietf-oauth-status-list-21
 * section 12.1), so an index says nothing of when a mandate was made. Indexes are never reused.
 */
export async function drawStatusIdx(db: Db): Promise<number> {
  for (let i = 0; i < 16; i++) {
    const tries = Array.from({ length: 8 }, () => randomInt(STATUS_SIZE));
    const taken = new Set(
      (
        await db
          .select({ idx: mandates.statusIdx })
          .from(mandates)
          .where(inArray(mandates.statusIdx, tries))
      ).map((r) => r.idx),
    );
    const free = tries.find((t) => !taken.has(t));
    if (free !== undefined) return free;
  }
  throw new Error("the status list is full");
}

/**
 * Has leg A sign the list as the mandates stand: the bit of every mandate whose revocation was
 * requested is set. Leg A signs only a list that keeps every bit it set before, and the stored
 * token is the one countersigns carry.
 */
export async function publishStatusList(deps: StatusListDeps): Promise<string> {
  const revoked = await deps.db
    .select({ idx: mandates.statusIdx })
    .from(mandates)
    .where(and(isNotNull(mandates.statusIdx), isNotNull(mandates.revokeRequestedAt)));
  const lst = await encodeStatusList(statusBits(revoked.map((r) => r.idx as number)));
  const { token } = await deps.tee.client.a.signStatus({ uri: STATUS_URI, lst });
  const signedAt = new Date();
  await deps.db
    .insert(statusLists)
    .values({ uri: STATUS_URI, token, signedAt })
    .onConflictDoUpdate({ target: statusLists.uri, set: { token, signedAt } });
  return token;
}

/** The token a countersign carries: the stored one while fresh, else a newly signed one. */
export async function currentStatusToken(deps: StatusListDeps): Promise<string> {
  const [row] = await deps.db.select().from(statusLists).where(eq(statusLists.uri, STATUS_URI));
  if (row && Date.now() - row.signedAt.getTime() < REFRESH_MS) return row.token;
  return publishStatusList(deps);
}

/** The latest published token, for `GET /status/v1/mandates/2026-1`; `null` before the first. */
export async function publishedStatusToken(db: Db): Promise<string | null> {
  const [row] = await db.select().from(statusLists).where(eq(statusLists.uri, STATUS_URI));
  return row?.token ?? null;
}
