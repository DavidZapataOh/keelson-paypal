import type { AlibiBundle, AlibiReceipt } from "../schema.ts";
import type { Check, CheckId, CheckStatus, VerifyOptions } from "./report.ts";

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
  reads?: string[];
  detail?: Record<string, string>;
}

export interface CheckDef {
  id: CheckId;
  step: number;
  /** What the check reads, reported when it fails on an unexpected error. */
  reads: string[];
  /** `null` when the input is a receipt and the check needs a section only a bundle carries. */
  run: (
    input: AlibiBundle | AlibiReceipt,
    opts: Required<VerifyOptions>,
  ) => Outcome | Promise<Outcome>;
}

export const pass = (detail?: Record<string, string>): Outcome =>
  detail ? { status: "pass", detail } : { status: "pass" };

/** Runs one check; a check never throws, an exception is its failure. */
export async function runCheck(
  def: CheckDef,
  input: AlibiBundle | AlibiReceipt,
  opts: Required<VerifyOptions>,
): Promise<Check> {
  const started = performance.now();
  const base = { id: def.id, step: def.step };
  try {
    const out = await def.run(input, opts);
    return {
      ...base,
      status: out.status,
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
