import type { Db } from "@keelson/db";
import { LogError } from "@keelson/log";
import type { Logger } from "pino";
import { appendLeaf, type LogConfig } from "../log/append.ts";
import type { StampWorker } from "../timestamps/worker.ts";
import { countersignOf, purchaseLeaf } from "./leaf.ts";
import { done, final, type Outcome, retry } from "./outcome.ts";

export interface LogStepDeps {
  db: Db;
  log: Logger;
  tlog?: LogConfig | undefined;
  stamps?: StampWorker | undefined;
}

/**
 * Appends the purchase's leaf to the Alibi log. Appending it again returns the same index, so a
 * resumed purchase runs it again safely.
 */
export async function logStep(
  deps: LogStepDeps,
  purchaseId: string,
): Promise<Outcome<{ index: bigint; leafHash: Uint8Array }>> {
  if (!deps.tlog) return final("log:not-configured");
  const out = await countersignOf(deps.db, purchaseId);
  const leaf = await purchaseLeaf(deps.db, purchaseId, out);
  try {
    const append = await appendLeaf(
      { db: deps.db, log: deps.log, tlog: deps.tlog, stamps: deps.stamps },
      purchaseId,
      leaf,
      out.countersign,
    );
    return done({ index: append.index, leafHash: append.leafHash });
  } catch (err) {
    if (!(err instanceof LogError)) throw err;
    if (err.kind === "rejected" || err.kind === "invalid") {
      return final(`log:${err.code ?? err.kind}`);
    }
    return retry(`log:${err.kind}`);
  }
}
