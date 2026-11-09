import { randomUUID } from "node:crypto";
import { type EvaluateDeps, type Evaluation, evaluateDispute } from "./evaluate.ts";
import { type RespondDeps, type Response, respondToDispute } from "./respond.ts";
import { type SettleDeps, type Settlement, settleDispute } from "./settle.ts";

export type RunDeps = EvaluateDeps & RespondDeps & SettleDeps;

export type Run =
  | { evaluation: Evaluation; settlement?: Settlement; response?: Response }
  | { status: "busy"; disputeId: string };

/**
 * Thrown to a run that must not skip a dispute another run holds; its caller retries.
 *
 * @internal
 */
export class DisputeBusyError extends Error {
  override name = "DisputeBusyError";
}

/** Longer than a workflow run may take; a crashed run's hold lapses on its own. */
const HOLD_MS = 300_000;
const RELEASE =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0";

/**
 * Attributes a dispute, settles it with the party at fault and answers PayPal, holding the dispute
 * so that the API's run on the webhook and the workflow's never overlap. A run that finds the
 * dispute held returns `busy`, or throws `DisputeBusyError` with `wait`; every step it then skips
 * is idempotent, so the run after it finds the work done.
 */
export async function runDispute(
  deps: RunDeps,
  disputeId: string,
  opts: { wait?: boolean } = {},
): Promise<Run> {
  const key = `dispute:run:${disputeId}`;
  const token = randomUUID();
  if ((await deps.kv.set(key, token, { NX: true, PX: HOLD_MS })) !== "OK") {
    if (opts.wait) throw new DisputeBusyError(`dispute ${disputeId} is being run`);
    return { status: "busy", disputeId };
  }
  try {
    const evaluation = await evaluateDispute(deps, disputeId);
    if (evaluation.status !== "attributed") return { evaluation };
    const settlement = await settleDispute(deps, disputeId);
    return { evaluation, settlement, response: await respondToDispute(deps, disputeId) };
  } finally {
    await deps.kv.eval(RELEASE, { keys: [key], arguments: [token] });
  }
}
