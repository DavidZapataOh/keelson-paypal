import { fromHex, type Json, jcs } from "@keelson/core";
import type { Trace } from "@keelson/policy";
import { type CheckDef, expect, pass } from "../check.ts";
import { openMandate } from "./mandate.ts";
import { isBundle, UNDISCLOSED } from "./util.ts";

/** Shown when the replay agrees on `decision` and `fired` but not on every byte. */
const REPLAY_ALERT =
  "the browser's trace differs from the TEE's beyond decision and fired; the TEE's trace stands";

const SHA256 = /^sha256:([0-9a-f]{64})$/;

/** The TEE's input to the evaluation, as far as the trace and the open mandate record it. */
function replayInput(trace: Trace, claims: Record<string, unknown>) {
  const { cnf: _, ...mandate } = claims;
  const bound = (id: string) => trace.fields.find((f) => f.id === id)?.bound;
  const budget = bound("budget");
  const evidence: Record<string, string[]> = {};
  for (const f of trace.fields) if (f.evidence.length) evidence[f.field] = f.evidence;
  return {
    mandate,
    budgetLeftMinor: typeof budget === "number" ? budget : 0,
    now: new Date(trace.t_tee),
    evidence,
    mandateHash: fromHex(trace.mandate_hash),
    cartHash: fromHex(trace.cart_hash.replace(SHA256, "0x$1")),
  };
}

/**
 * The trace is what the pinned policy set decides for this mandate and this context: Cedar is
 * run again in the verifier on the trace's context, with the budget and evidence it records and
 * the engine build it names. Byte-equal passes; the same `decision` and `fired` with other bytes
 * passes with an alert, as the TEE's trace stands; another decision fails.
 */
export const replay: CheckDef = {
  id: "policy.replay",
  step: 5,
  reads: ["/eval", "/mandate"],
  async run(input) {
    if (!isBundle(input)) return UNDISCLOSED;
    const trace = input.eval as unknown as Trace;
    const c = input.tee.countersign;
    const policy = await import("@keelson/policy");
    expect(
      trace.policy_set_hash === policy.POLICY_SET_HASH &&
        trace.schema_hash === policy.SCHEMA_HASH &&
        `0x${trace.policy_set_hash.slice("sha256:".length)}` === c.policySetHash,
      "the trace's policy set or schema is not the pinned one",
      ["/eval/policy_set_hash", "/eval/schema_hash", "/tee/countersign/policySetHash"],
    );
    expect(trace.extras_hash === undefined, "the trace names extras the Alibi does not carry", [
      "/eval/extras_hash",
    ]);
    expect(
      trace.mandate_hash === c.mandateHash &&
        SHA256.test(trace.cart_hash) &&
        trace.cart_hash.slice("sha256:".length) === c.cartHash.slice(2),
      "the trace's mandate or cart hash is not the countersigned one",
      [
        "/eval/mandate_hash",
        "/eval/cart_hash",
        "/tee/countersign/mandateHash",
        "/tee/countersign/cartHash",
      ],
    );
    let claims: Record<string, unknown>;
    try {
      claims = (await openMandate(input)).claims;
    } catch (err) {
      expect(false, `the open mandate does not verify: ${(err as Error).message}`, ["/mandate"]);
    }
    const { mandate, ...rest } = replayInput(trace, claims);
    const ours = policy.evaluateContext(
      // The open mandate's key binding is signed by its `cnf`, the agent it names, so that agent
      // is the requester the TEE authenticated.
      { ...rest, mandate, agent: policy.mandateAgent(mandate) },
      trace.context,
      { ...trace.engine, proof_bundle_hash: trace.proof_bundle_hash },
    );
    expect(
      ours.decision === trace.decision && jcs(ours.fired) === jcs(trace.fired),
      `the pinned policy set decides ${ours.decision}${ours.fired.length ? ` (${ours.fired.join(", ")})` : ""}, not ${trace.decision}`,
      ["/eval/decision", "/eval/fired", "/eval/context", "/eval/fields", "/mandate"],
    );
    if (jcs(ours as unknown as Json) === jcs(trace as unknown as Json)) return pass();
    return pass({ alert: REPLAY_ALERT });
  },
};
