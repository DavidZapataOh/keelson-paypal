import { statementImprint } from "@keelson/scitt";
import { TimestampError, type TsaId, verifyTimestamp } from "@keelson/timestamp";
import { fromBase64 } from "../../b64.ts";
import { leafHashOf } from "../../codec.ts";
import { type CheckDef, expect, pass } from "../check.ts";
import { OFFLINE } from "../report.ts";
import { c1Statement, c3Statement, verifyC1, verifyC3 } from "../zk.ts";
import { isBundle } from "./util.ts";

/**
 * Every RFC 3161 token stamps, under a pinned TSA root, the leaf hash (v1) or the statement's
 * signature (v2, RFC 9921 `3161-ctt`); pending while none has.
 */
export const timestamps: CheckDef = {
  id: "timestamps",
  step: 8,
  reads: ["/timestamps"],
  async run(input, { now, view }) {
    if (input.timestamps.length === 0) return { status: "pending", reads: ["/timestamps"] };
    const imprint = view ? statementImprint(view.transparent.signature) : leafHashOf(input);
    const detail: Record<string, string> = {};
    for (const [i, t] of input.timestamps.entries()) {
      const at = [`/timestamps/${i}/token`, `/timestamps/${i}/tsa`];
      try {
        const v = await verifyTimestamp(fromBase64(t.token), imprint, {
          ...(t.tsa ? { expectedTsa: t.tsa as TsaId } : {}),
          now,
        });
        detail[v.tsa] = v.genTime;
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
    if (!isBundle(input) || !input.zk?.c1) return { status: "absent", reads: [] };
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

/**
 * The C3 proof shows that a passkey in Keelson's registered-user tree signed the mandate the
 * countersign names, without saying which: its public inputs are the countersign's
 * `mandateCommitment` and `mandateHash`, a root and Keelson's RP ID hash; it verifies with bb.js
 * against the pinned key; and, read on chain, the pinned `RegisteredUserSet` holds the root, not revoked, which
 * the stated transaction published. Pending offline; absent when the Alibi carries no proof.
 */
export const zkC3: CheckDef = {
  id: "zk.c3",
  step: 8,
  reads: ["/zk/c3", "/tee/countersign/mandateCommitment", "/tee/countersign/mandateHash"],
  async run(input, ctx) {
    if (!isBundle(input) || !input.zk?.c3) return { status: "absent", reads: [] };
    const { proof, public_inputs, root_tx } = input.zk.c3;
    const c = input.tee.countersign;
    const root = public_inputs[2] as string;
    const statement = c3Statement({
      mandateCommitment: c.mandateCommitment,
      mandateHash: c.mandateHash,
      userSetRoot: root,
    });
    expect(
      public_inputs.every((p, i) => p === statement[i]),
      "the proof is of another mandate or RP",
      [
        "/zk/c3/public_inputs",
        "/tee/countersign/mandateCommitment",
        "/tee/countersign/mandateHash",
      ],
    );
    expect(await verifyC3(proof, public_inputs), "the proof does not verify", ["/zk/c3/proof"]);
    const detail: Record<string, string> = {
      verifier: "bb.js",
      user_set_root: root,
      root_tx,
      chain_id: String(input.tee.domain.chain_id),
    };
    if (!ctx.chain) return { status: "pending", reason: OFFLINE, detail };
    let a: Awaited<NonNullable<typeof ctx.chain>>;
    try {
      a = await ctx.chain;
    } catch (err) {
      return { status: "unreachable", reason: (err as Error).message, detail };
    }
    const r = a.c3;
    if (!r) {
      return {
        status: "unreachable",
        reason: "no RegisteredUserSet is pinned on this chain",
        detail,
      };
    }
    expect(r.publishedAt > 0, `the root ${root} is not published in RegisteredUserSet`, [
      "/zk/c3/public_inputs",
    ]);
    expect(r.revokedAt === 0, `the root ${root} was revoked`, ["/zk/c3/public_inputs"]);
    expect(r.log, "the root's transaction is not on chain or published no such root", [
      "/zk/c3/root_tx",
    ]);
    return pass({
      ...detail,
      users: String(r.size),
      published_at: new Date(r.publishedAt * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
  },
};
