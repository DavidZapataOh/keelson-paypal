import { deploymentsFor } from "@keelson/chain";
import { fromHex, toHex } from "@keelson/core";
import {
  LOG_ORIGINS,
  verifyConsistency,
  verifyProofOfOrigin,
  verifyWitnessedCheckpoint,
} from "@keelson/log";
import { leafHashOf } from "../../codec.ts";
import { type CheckDef, expect, pass } from "../check.ts";
import { isBundle, pinnedOrigin, proofCheckpoint } from "./util.ts";

/**
 * Offline half of the anchor: its checkpoint is witnessed under the pinned keys, it covers the
 * leaf, and the consistency proof links it to the checkpoint of the inclusion proof in the
 * direction their sizes give. Pending until the bundle carries an anchor.
 */
export const anchor: CheckDef = {
  id: "anchor.consistency",
  step: 7,
  reads: ["/anchor"],
  run(input, { now }) {
    const a = input.anchor;
    if (!a) return { status: "pending", reads: ["/anchor"] };
    if (isBundle(input)) {
      expect(a.chain_id === input.tee.domain.chain_id, "the anchor is on another chain", [
        "/anchor/chain_id",
        "/tee/domain/chain_id",
      ]);
    }
    const origin = pinnedOrigin(proofCheckpoint(input.tlog_proof));
    expect(LOG_ORIGINS[a.chain_id] === origin, "the anchor is on a chain this log is not", [
      "/anchor/chain_id",
    ]);
    expect(
      a.contract === deploymentsFor(a.chain_id).CheckpointAnchor,
      "the anchor contract is not Keelson's",
      ["/anchor/contract"],
    );
    let anchored: ReturnType<typeof verifyWitnessedCheckpoint>;
    try {
      anchored = verifyWitnessedCheckpoint(a.checkpoint, now);
    } catch (err) {
      const m = /quorum not met: (\d+) of (\d+)/.exec((err as Error).message);
      expect(false, m ? `${m[1]} of ${m[2]}` : (err as Error).message, ["/anchor/checkpoint"]);
    }
    expect(anchored.origin === origin, "the anchor is of another log", ["/anchor/checkpoint"]);
    expect(anchored.size === BigInt(a.anchored_size), "the anchored size is not the checkpoint's", [
      "/anchor/anchored_size",
      "/anchor/checkpoint",
    ]);
    expect(toHex(anchored.root) === a.anchored_root, "the anchored root is not the checkpoint's", [
      "/anchor/anchored_root",
      "/anchor/checkpoint",
    ]);
    const { index, checkpoint } = verifyProofOfOrigin(input.tlog_proof, leafHashOf(input), origin);
    expect(index < anchored.size, "the anchor does not cover the leaf", ["/anchor/anchored_size"]);
    const older = anchored.size <= checkpoint.size;
    const [from, to] = older ? [anchored, checkpoint] : [checkpoint, anchored];
    expect(
      a.consistency.from === String(from.size) && a.consistency.to === String(to.size),
      "the consistency proof is not between the anchor and the proof checkpoint",
      ["/anchor/consistency"],
    );
    expect(
      verifyConsistency(from.size, to.size, from.root, to.root, a.consistency.proof.map(fromHex)),
      "the consistency proof does not link the anchor to the proof checkpoint",
      ["/anchor/consistency/proof"],
    );
    return pass({ anchored_size: a.anchored_size, chain_id: String(a.chain_id) });
  },
};
