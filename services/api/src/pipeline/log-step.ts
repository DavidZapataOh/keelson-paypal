import type { Db } from "@keelson/db";
import { LogError } from "@keelson/log";
import type { Logger } from "pino";
import { AlibiIssueError, issueAlibi } from "../alibi/issue.ts";
import { appendLeaf, type LogConfig } from "../log/append.ts";
import type { PayPalDeps } from "../paypal.ts";
import type { TeeConfig } from "../tee/signers.ts";
import type { StampWorker } from "../timestamps/worker.ts";
import { span } from "../tracing.ts";
import { countersignOf, purchaseLeaf } from "./leaf.ts";
import { done, final, type Outcome, retry } from "./outcome.ts";

export interface LogStepDeps {
  db: Db;
  log: Logger;
  tlog?: LogConfig | undefined;
  stamps?: StampWorker | undefined;
  tee?: Pick<TeeConfig, "client"> | undefined;
  paypal?: Pick<PayPalDeps, "merchantId"> | undefined;
  proveAnonymousPurchase?: ((purchaseId: string) => Promise<void>) | undefined;
}

/**
 * Appends the purchase's leaf to the Alibi log and issues its Alibi. Appending it again returns
 * the same index and a fresh proof, so a resumed purchase runs it again safely and still gets its
 * Alibi; nothing is captured without one.
 */
export async function logStep(
  deps: LogStepDeps,
  purchaseId: string,
): Promise<Outcome<{ index: bigint; leafHash: Uint8Array }>> {
  const tlog = deps.tlog;
  if (!tlog) return final("log:not-configured");
  const out = await countersignOf(deps.db, purchaseId);
  const leaf = await purchaseLeaf(deps.db, purchaseId, out);
  try {
    const append = await span("log.append", {}, () =>
      appendLeaf(
        { db: deps.db, log: deps.log, tlog, stamps: deps.stamps },
        purchaseId,
        leaf,
        out.countersign,
      ),
    );
    try {
      await span("alibi.issue", {}, () =>
        issueAlibi(
          { db: deps.db, log: deps.log, tee: deps.tee, merchantId: deps.paypal?.merchantId },
          { purchaseId, append },
        ),
      );
    } catch (err) {
      if (err instanceof AlibiIssueError) {
        deps.log.error({ purchaseId, code: err.code, detail: err.message }, "alibi refused");
        return final(`alibi:${err.code}`);
      }
      deps.log.warn({ err, purchaseId }, "alibi not issued yet");
      return retry("alibi:unavailable");
    }
    // The Alibi carries the purchase's C1 proof now: compose it with the mandate's C3, off the path.
    void deps
      .proveAnonymousPurchase?.(purchaseId)
      .catch((err: unknown) => deps.log.warn({ err, purchaseId }, "composed proof not started"));
    return done({ index: append.index, leafHash: append.leafHash });
  } catch (err) {
    if (!(err instanceof LogError)) throw err;
    if (err.kind === "rejected" || err.kind === "invalid") {
      return final(`log:${err.code ?? err.kind}`);
    }
    return retry(`log:${err.kind}`);
  }
}
