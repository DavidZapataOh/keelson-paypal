import { asc, type Db, desc, eq, timestamps } from "@keelson/db";
import type { TsaId } from "@keelson/timestamp";
import type { Logger } from "pino";
import type { StampWorker } from "./worker.ts";

/** `statement`: SHA-256 of the CBOR byte string of a v2 statement's signature (RFC 9921). */
export type StampKind = "leaf" | "channel3" | "statement";

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

/** Every row over `hash`, primaries first, in one query. */
export function rowsFor(db: Db, hash: Uint8Array): Promise<(typeof timestamps.$inferSelect)[]> {
  return db
    .select()
    .from(timestamps)
    .where(eq(timestamps.hash, Buffer.from(hash)))
    .orderBy(desc(timestamps.role), asc(timestamps.tsa));
}

/** The stamped tokens among `rows`, in their order. */
export function storedStamps(rows: (typeof timestamps.$inferSelect)[]): StoredStamp[] {
  return rows
    .filter((row) => row.status === "stamped")
    .map((row) => ({
      tsa: row.tsa as TsaId,
      role: row.role as StoredStamp["role"],
      token: (row.token as Buffer).toString("base64"),
      genTime: (row.genTime as Date).toISOString(),
      serial: row.serial as string,
    }));
}

/**
 * The stamped tokens over `hash`, primaries first: an Alibi's `timestamps` field.
 *
 * @public
 */
export async function stampsFor(db: Db, hash: Uint8Array): Promise<StoredStamp[]> {
  return storedStamps(await rowsFor(db, hash));
}
