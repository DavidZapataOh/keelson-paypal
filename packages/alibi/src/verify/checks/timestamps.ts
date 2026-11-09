import { TimestampError, type TsaId, verifyTimestamp } from "@keelson/timestamp";
import { fromBase64 } from "../../b64.ts";
import { leafHashOf } from "../../codec.ts";
import { type CheckDef, expect, pass } from "../check.ts";

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

/** No zero-knowledge proof is carried yet, so the C1 claim is absent, never passed. */
export const zk: CheckDef = {
  id: "zk.c1",
  step: 8,
  reads: [],
  run: () => ({ status: "absent", reads: [] }),
};
