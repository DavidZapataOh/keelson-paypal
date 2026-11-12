import type { AlibiBundle, AlibiReceipt } from "../schema.ts";
import type { ChainAnswer } from "./chain.ts";
import type { Check, CheckId, CheckStatus, VerifyOptions } from "./report.ts";
import type { StatementView } from "./view.ts";

/** A check's failure: why, and the pointers of the values that do not hold. */
class CheckFailure extends Error {
  readonly reads: string[];

  constructor(reason: string, reads: string[]) {
    super(reason);
    this.reads = reads;
  }
}

/** Fails the running check unless `ok`. */
export function expect(ok: unknown, reason: string, reads: string[]): asserts ok {
  if (!ok) throw new CheckFailure(reason, reads);
}

export interface Outcome {
  status: CheckStatus;
  reason?: string;
  reads?: string[];
  detail?: Record<string, string>;
}

/** What every check of one verification shares. */
export interface Context {
  now: Date;
  expect: VerifyOptions["expect"];
  /** The one chain read of this verification; `null` offline. */
  chain: Promise<ChainAnswer> | null;
  /** The v2 statement, `null` for a v1 Alibi; checks then read the v1-shaped projection. */
  view: StatementView | null;
  /** The pinned RFC 9942 receipt keys, by hex key id. */
  receiptKeys: ReadonlyMap<string, Uint8Array>;
}

export interface CheckDef {
  id: CheckId;
  step: number;
  /** What the check reads, reported when it fails on an unexpected error. */
  reads: string[];
  /** `null` when the input is a receipt and the check needs a section only a bundle carries. */
  run: (input: AlibiBundle | AlibiReceipt, ctx: Context) => Outcome | Promise<Outcome>;
}

export const pass = (detail?: Record<string, string>): Outcome =>
  detail ? { status: "pass", detail } : { status: "pass" };

/** Runs one check; a check never throws, an exception is its failure. */
export async function runCheck(
  def: CheckDef,
  input: AlibiBundle | AlibiReceipt,
  ctx: Context,
): Promise<Check> {
  const started = performance.now();
  const base = { id: def.id, step: def.step };
  try {
    const out = await def.run(input, ctx);
    return {
      ...base,
      status: out.status,
      ...(out.reason ? { reason: out.reason } : {}),
      reads: out.reads ?? def.reads,
      ms: performance.now() - started,
      ...(out.detail ? { detail: out.detail } : {}),
    };
  } catch (err) {
    const failure = err instanceof CheckFailure;
    return {
      ...base,
      status: "fail",
      reason: err instanceof Error ? err.message : String(err),
      reads: failure ? err.reads : def.reads,
      ms: performance.now() - started,
    };
  }
}
