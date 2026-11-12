import { verifyProofOfOrigin } from "@keelson/log";
import { RECEIPTS, ScittReceiptError, verifyReceipt } from "@keelson/scitt";
import { leafHashOf } from "../../codec.ts";
import { type CheckDef, expect, pass } from "../check.ts";
import { pinnedOrigin, proofCheckpoint } from "./util.ts";

/**
 * The statement's RFC 9942 receipt includes the registered statement in a tree whose root a pinned
 * receipt key signed, and, when the witnessed proof is there, names the same index, size and root.
 */
export const receipt: CheckDef = {
  id: "scitt.receipt",
  step: 6,
  reads: ["/statement"],
  run(input, { view, receiptKeys }) {
    if (!view) return { status: "absent", reads: [] };
    const receipts = view.transparent.unprotected.get(RECEIPTS);
    if (!Array.isArray(receipts) || receipts.length === 0) {
      return { status: "pending", reason: "no receipt yet", reads: ["/statement"] };
    }
    let out: ReturnType<typeof verifyReceipt>;
    try {
      out = verifyReceipt(receipts[0] as Uint8Array, view.registered, receiptKeys);
    } catch (err) {
      const code = err instanceof ScittReceiptError ? err.code : "format";
      expect(false, code === "kid" ? "the receipt key is not pinned" : `receipt ${code}`, [
        "/statement",
      ]);
    }
    const detail = { size: String(out.treeSize), index: String(out.leafIndex), kid: out.kid };
    if (!input.tlog_proof) return pass(detail);
    const proof = verifyProofOfOrigin(
      input.tlog_proof,
      leafHashOf(input),
      pinnedOrigin(proofCheckpoint(input.tlog_proof)),
    );
    expect(
      BigInt(proof.index) === out.leafIndex &&
        BigInt(proof.checkpoint.size) === out.treeSize &&
        proof.checkpoint.root.every((b, i) => b === out.root[i]),
      "the receipt and the witnessed proof name different trees",
      ["/statement", "/tlog_proof"],
    );
    return pass(detail);
  },
};
