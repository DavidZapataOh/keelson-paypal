import { and, asc, type Db, desc, eq, timestamps } from "@keelson/db";
import type { TsaId } from "@keelson/timestamp";
import type { Logger } from "pino";
import type { StampWorker } from "./worker.ts";

export type StampKind = "leaf" | "channel3";

/** The two independent TSAs every hash is stamped by. */
const PRIMARIES: TsaId[] = ["digicert", "sigstore"];

/** A stored token, as the Alibi carries it. */
export interface StoredStamp {
  tsa: TsaId;
  role: "primary" | "fallback";
  /** Base64 DER `TimeStampToken`. */
  token: string;
  /** RFC 3339, UTC. */
  genTime: string;
  serial: string;
}

/**
 * Queues `hash` for a token from each primary TSA and wakes the worker. It returns at once and
 * never throws: nothing on the request path waits for a TSA or for this insert.
 */
export function enqueueStamp(
  deps: { db: Db; log: Logger; stamps?: StampWorker | undefined },
  hash: Uint8Array,
  kind: StampKind,
): void {
  const rows = PRIMARIES.map((tsa) => ({ hash: Buffer.from(hash), kind, tsa, role: "primary" }));
  deps.db
    .insert(timestamps)
    .values(rows)
    .onConflictDoNothing()
    .then(
      () => deps.stamps?.wake(),
      (err: unknown) => deps.log.error({ err, kind }, "timestamp could not be queued"),
    );
}

/** The stamped tokens over `hash`, primaries first. */
export async function stampsFor(db: Db, hash: Uint8Array): Promise<StoredStamp[]> {
  const rows = await db
    .select()
    .from(timestamps)
    .where(and(eq(timestamps.hash, Buffer.from(hash)), eq(timestamps.status, "stamped")))
    .orderBy(desc(timestamps.role), asc(timestamps.tsa));
  return rows.map((row) => ({
    tsa: row.tsa as TsaId,
    role: row.role as StoredStamp["role"],
    token: (row.token as Buffer).toString("base64"),
    genTime: (row.genTime as Date).toISOString(),
    serial: row.serial as string,
  }));
}
