import { type Channel3EventSummary, channel3PriceMinor, type Json, sha256 } from "@keelson/core";
import { and, channel3Events, type Db, desc, eq, gt } from "@keelson/db";
import type { Logger } from "pino";
import { enqueueStamp } from "../timestamps/queue.ts";
import type { StampWorker } from "../timestamps/worker.ts";

/** The envelope of a Channel3 offer event. */
interface OfferEvent {
  id: string;
  type: string;
  timestamp: string;
  data?: { subject?: { product_id?: unknown; domain?: unknown }; current?: unknown };
}

function isOfferEvent(v: unknown): v is OfferEvent {
  const e = v as Partial<OfferEvent> | null;
  return (
    typeof e?.id === "string" &&
    typeof e.type === "string" &&
    typeof e.timestamp === "string" &&
    /^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(e.timestamp) &&
    !Number.isNaN(Date.parse(e.timestamp))
  );
}

/**
 * Stores a verified delivery once per event `id`, as the exact bytes Channel3 sent, and queues
 * RFC 3161 tokens over their hash. Returns `false` for a body that is not an offer event.
 * Unknown event types are stored too: Channel3 may add types.
 */
export async function storeEvent(
  deps: { db: Db; log: Logger; stamps?: StampWorker | undefined },
  event: unknown,
  body: Uint8Array,
  svixId: string,
): Promise<boolean> {
  if (!isOfferEvent(event)) return false;
  const subject = event.data?.subject;
  const contentHash = sha256(body);
  const inserted = await deps.db
    .insert(channel3Events)
    .values({
      id: event.id,
      type: event.type,
      productId: typeof subject?.product_id === "string" ? subject.product_id : null,
      domain: typeof subject?.domain === "string" ? subject.domain : null,
      committedAt: new Date(event.timestamp),
      svixId,
      body: Buffer.from(body),
      contentHash: Buffer.from(contentHash),
    })
    .onConflictDoNothing({ target: channel3Events.id })
    .returning({ id: channel3Events.id });
  if (inserted.length > 0) {
    enqueueStamp(deps, contentHash, "channel3");
    deps.log.info({ id: event.id, type: event.type }, "channel3 event stored");
  }
  return true;
}

const WINDOW_MS = 7 * 24 * 3_600_000;

/** An event's `current` state, with prices as minor-unit strings. */
function current(value: unknown): Json {
  if (typeof value === "string") return value;
  const c = value as { price?: unknown; compare_at_price?: unknown; currency?: unknown } | null;
  if (typeof c?.currency !== "string") return null;
  return {
    price_minor: channel3PriceMinor(c.price, c.currency),
    ...(typeof c.compare_at_price === "number"
      ? { compare_at_minor: channel3PriceMinor(c.compare_at_price, c.currency) }
      : {}),
    currency: c.currency,
  };
}

/** The five newest stored events for one product on one merchant domain, from the last week. */
export async function recentEvents(
  db: Db,
  productId: string,
  domain: string,
  now = Date.now(),
): Promise<Channel3EventSummary[]> {
  const rows = await db
    .select({
      id: channel3Events.id,
      type: channel3Events.type,
      body: channel3Events.body,
      committedAt: channel3Events.committedAt,
    })
    .from(channel3Events)
    .where(
      and(
        eq(channel3Events.productId, productId),
        eq(channel3Events.domain, domain),
        gt(channel3Events.committedAt, new Date(now - WINDOW_MS)),
      ),
    )
    .orderBy(desc(channel3Events.committedAt))
    .limit(5);
  return rows.map((row) => {
    const event = JSON.parse(row.body.toString("utf8")) as OfferEvent;
    return {
      id: row.id,
      type: row.type,
      committedAt: row.committedAt.toISOString(),
      current: current(event.data?.current),
    };
  });
}
