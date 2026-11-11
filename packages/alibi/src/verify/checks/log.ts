import {
  LOG_ORIGINS,
  LOG_WITNESSES,
  logVkeySets,
  parseWitnessPolicy,
  verifyCosignatures,
  type verifyProof,
  verifyProofOfOrigin,
} from "@keelson/log";
import { leafHashOf } from "../../codec.ts";
import { type CheckDef, expect, pass } from "../check.ts";
import { isBundle, pinnedOrigin, proofCheckpoint, sameJson, UNDISCLOSED } from "./util.ts";

/** The policy in the bundle is the one pinned for the origin of the purchase's chain. */
export const policy: CheckDef = {
  id: "log.policy",
  step: 6,
  reads: ["/policy"],
  run(input) {
    if (!isBundle(input)) return UNDISCLOSED;
    const origin = input.policy.origin;
    expect(origin === LOG_ORIGINS[input.tee.domain.chain_id], "origin", [
      "/policy/origin",
      "/tee/domain/chain_id",
    ]);
    expect(pinnedOrigin(proofCheckpoint(input.tlog_proof)) === origin, "origin", [
      "/policy/origin",
      "/tlog_proof",
    ]);
    const p = parseWitnessPolicy(input.policy.text);
    const witnesses = LOG_WITNESSES[origin];
    expect(
      logVkeySets(origin).some((set) => sameJson(p.logs, set.vkeys)) &&
        witnesses !== undefined &&
        p.quorum.k === witnesses.quorum &&
        sameJson(
          p.quorum.members.map((m) => p.witnesses.get(m)),
          witnesses.vkeys,
        ),
      "pinned",
      ["/policy/text"],
    );
    return pass();
  },
};

/** The proof includes the leaf in a checkpoint both pinned log keys signed. */
export const inclusion: CheckDef = {
  id: "log.inclusion",
  step: 6,
  reads: ["/tlog_proof", "/leaf"],
  run(input) {
    const origin = pinnedOrigin(proofCheckpoint(input.tlog_proof));
    let out: ReturnType<typeof verifyProof>;
    try {
      out = verifyProofOfOrigin(input.tlog_proof, leafHashOf(input), origin);
    } catch {
      expect(false, "not included", ["/tlog_proof", "/leaf"]);
    }
    return pass({ index: String(out.index), size: String(out.checkpoint.size), origin });
  },
};

/** The proof's checkpoint carries the pinned witness quorum. */
export const witnesses: CheckDef = {
  id: "log.witnesses",
  step: 6,
  reads: ["/tlog_proof"],
  run(input, { now }) {
    const checkpoint = proofCheckpoint(input.tlog_proof);
    const set = LOG_WITNESSES[pinnedOrigin(checkpoint)];
    expect(set, "no witnesses are pinned for this origin", ["/tlog_proof"]);
    let cosigners: string[];
    try {
      cosigners = verifyCosignatures(checkpoint, set, now).cosigners;
    } catch (err) {
      const m = /quorum not met: (\d+) of (\d+)/.exec((err as Error).message);
      expect(false, m ? `${m[1]} of ${m[2]}` : (err as Error).message, ["/tlog_proof"]);
    }
    return pass({ cosigners: cosigners.join(" ") });
  },
};
