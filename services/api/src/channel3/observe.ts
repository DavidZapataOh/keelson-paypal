import { randomBytes } from "node:crypto";
import {
  type AgentView,
  type Channel3Comparison,
  type Channel3Product,
  compareChannel3,
  type Json,
  jcs,
  normalizeProduct,
  observationDocument,
  sha256,
  toHex,
} from "@keelson/core";
import { channel3Observations, type Db } from "@keelson/db";
import type { Logger } from "pino";
import { ulid } from "ulid";
import { enqueueStamp } from "../timestamps/queue.ts";
import type { StampWorker } from "../timestamps/worker.ts";
import type { Channel3Lookup } from "./client.ts";
import { recentEvents } from "./webhook.ts";

/** Response bodies larger than this are hashed but not kept. */
const MAX_RAW_BYTES = 512 * 1024;

export interface ObserveDeps {
  db: Db;
  log: Logger;
  stamps?: StampWorker | undefined;
  channel3: Channel3Lookup;
}

export interface Observation {
  id: string;
  status: "ok" | "unavailable";
  document: Json;
  /** The JCS bytes of `document`: the bytes of the `channel3.observation` evidence item. */
  bytes: Uint8Array;
  contentHash: Uint8Array;
  salt: Uint8Array;
  comparison: Channel3Comparison;
  /** How long Channel3 took to answer. */
  lookupMs: number;
}

/**
 * Asks Channel3 about the product page the agent is on, compares its answer with what the agent
 * saw, stores both, and queues RFC 3161 tokens over the document's hash. A failed lookup is
 * stored too, as `unavailable`, so the absence of a second source is on record.
 */
export async function observe(
  deps: ObserveDeps,
  input: { mandateId: string; requestedBy: string; url: string; agentView: AgentView },
): Promise<Observation> {
  const id = ulid();
  const requestedAtMs = Date.now();
  const started = performance.now();
  const res = await deps.channel3.lookup(input.url);
  const lookupMs = performance.now() - started;

  let product: Channel3Product | null = null;
  let error = res.error;
  if (!error) {
    try {
      product = normalizeProduct(res.product);
    } catch {
      error = "invalid-response";
    }
  }
  const status = product ? "ok" : "unavailable";
  const comparison = compareChannel3(input.agentView, product);
  // Channel3's signed offer events for the same offer are a dated second account of it.
  const webhookEvents =
    product && comparison.offerDomain
      ? await recentEvents(deps.db, product.id, comparison.offerDomain)
      : [];
  const document = observationDocument({
    id,
    url: input.url,
    requestedAtMs,
    receivedAtMs: res.receivedAtMs,
    status,
    ...(error ? { error } : {}),
    ...(res.status ? { httpStatus: res.status } : {}),
    responseSha256: toHex(sha256(res.raw)),
    ...(product ? { product } : {}),
    agentView: input.agentView,
    comparison,
    webhookEvents,
  });
  const bytes = new TextEncoder().encode(jcs(document));
  const contentHash = sha256(bytes);
  const salt = new Uint8Array(randomBytes(32));

  await deps.db.insert(channel3Observations).values({
    id,
    mandateId: input.mandateId,
    requestedBy: input.requestedBy,
    url: input.url,
    status,
    document,
    contentHash: Buffer.from(contentHash),
    salt: Buffer.from(salt),
    raw: res.raw.length <= MAX_RAW_BYTES ? Buffer.from(res.raw) : null,
  });
  enqueueStamp(deps, contentHash, "channel3");
  if (error) deps.log.warn({ id, error, status: res.status }, "channel3 lookup unavailable");
  return { id, status, document, bytes, contentHash, salt, comparison, lookupMs };
}
