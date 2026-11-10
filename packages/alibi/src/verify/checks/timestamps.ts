import { TimestampError, type TsaId, verifyTimestamp } from "@keelson/timestamp";
import { fromBase64 } from "../../b64.ts";
import { leafHashOf } from "../../codec.ts";
import { type CheckDef, expect, pass } from "../check.ts";
import { c1Statement, verifyC1 } from "../zk.ts";
import { isBundle } from "./util.ts";

/** Every RFC 3161 token stamps the leaf hash under a pinned TSA root; pending while none has. */
export const timestamps: CheckDef = {
  id: "timestamps",
  step: 8,
  reads: ["/timestamps"],
  async run(input, { now }) {
    if (input.timestamps.length === 0) return { status: "pending", reads: ["/timestamps"] };
    const imprint = leafHashOf(input);
    const detail: Record<string, string> = {};
    for (const [i, t] of input.timestamps.entries()) {
      const at = [`/timestamps/${i}/token`, `/timestamps/${i}/tsa`];
      try {
        const v = await verifyTimestamp(fromBase64(t.token), imprint, {
          expectedTsa: t.tsa as TsaId,
          now,
        });
        detail[t.tsa] = v.genTime;
      } catch (err) {
        const imprintError = err instanceof TimestampError && err.code === "tsa-imprint";
        expect(false, imprintError ? "imprint" : (err as Error).message, at);
      }
    }
    return pass(detail);
  },
};

/**
 * The C1 proof shows the mandate `mandateCommitment` commits to allows this countersign's amount,
 * currency, category, merchant and time, without the mandate: its public inputs are the
 * countersign's fields, it verifies with bb.js against the pinned key and, read on chain, the
 * deployed verifier accepts it in an `eth_call`. Absent when the Alibi carries no proof.
 */
export const zk: CheckDef = {
  id: "zk.c1",
  step: 8,
  reads: ["/zk/c1", "/tee/countersign"],
  async run(input, ctx) {
    if (!isBundle(input) || !input.zk) return { status: "absent", reads: [] };
    const { proof, public_inputs } = input.zk.c1;
    const statement = c1Statement(input.tee.countersign);
    expect(
      public_inputs.every((p, i) => p === statement[i]),
      "the proof is of another countersign",
      ["/zk/c1/public_inputs", "/tee/countersign"],
    );
    expect(await verifyC1(proof, public_inputs), "the proof does not verify", ["/zk/c1/proof"]);
    const detail: Record<string, string> = { verifier: "bb.js" };
    const answer = await ctx.chain?.catch(() => undefined);
    if (answer?.c1 !== undefined) {
      expect(answer.c1, "the on-chain verifier rejects the proof", ["/zk/c1/proof"]);
      detail.onchain = "verified";
    }
    return pass(detail);
  },
};
