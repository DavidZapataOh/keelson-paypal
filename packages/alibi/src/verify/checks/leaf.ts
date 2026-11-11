import { ulidToBytes32 } from "@keelson/core";
import { LEAF_PREFIX, leafBytes, leafHash } from "@keelson/log";
import type { Hex } from "viem";
import { fromBase64url, toBase64url } from "../../b64.ts";
import { type CheckDef, expect, pass } from "../check.ts";
import { b64urlOfHex, isBundle, leafBytesOf, measurementHex, sameJson } from "./util.ts";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const hexOfB64url = (s: string): Hex =>
  `0x${Array.from(fromBase64url(s), (b) => b.toString(16).padStart(2, "0")).join("")}`;
const rfc3339 = (unix: string) =>
  new Date(Number(unix) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * The leaf bytes are the log's prefix and the RFC 8785 form of `leaf_view`, and every value the
 * leaf states is the one the section carrying it holds.
 */
export const leaf: CheckDef = {
  id: "leaf.view",
  step: 0,
  reads: ["/leaf", "/leaf_view"],
  run(input, ctx) {
    if (ctx.view) return { status: "absent", reads: [] };
    const bytes = leafBytesOf(input);
    const text = decoder.decode(bytes);
    expect(text.startsWith(LEAF_PREFIX), "the leaf does not start with the log's prefix", [
      "/leaf",
    ]);
    const body = JSON.parse(text.slice(LEAF_PREFIX.length)) as Record<string, unknown>;
    expect(body.alibi_id === input.alibi_id, "the leaf is another alibi's", ["/leaf", "/alibi_id"]);
    if (!isBundle(input)) {
      expect(toBase64url(leafHash(bytes)) === input.leaf_hash, "leaf_hash", ["/leaf_hash"]);
      return pass();
    }
    expect(sameJson(body, input.leaf_view), "leaf_view is not the leaf", ["/leaf", "/leaf_view"]);

    const { tee } = input;
    const c = tee.countersign;
    expect(c.requestId === ulidToBytes32(input.alibi_id), "requestId is not this alibi", [
      "/tee/countersign/requestId",
      "/alibi_id",
    ]);
    const view = input.leaf_view;
    const bound: [string, unknown, string][] = [
      ["cart_hash", b64urlOfHex(c.cartHash), "/tee/countersign/cartHash"],
      ["mandate_hash", b64urlOfHex(c.mandateHash), "/tee/countersign/mandateHash"],
      [
        "mandate_commitment",
        b64urlOfHex(c.mandateCommitment),
        "/tee/countersign/mandateCommitment",
      ],
      ["evidence_root", b64urlOfHex(c.evidenceRoot), "/tee/countersign/evidenceRoot"],
      ["eval_hash", b64urlOfHex(c.evalHash), "/tee/countersign/evalHash"],
      ["policy_set_hash", b64urlOfHex(c.policySetHash), "/tee/countersign/policySetHash"],
      ["countersign_digest", b64urlOfHex(tee.digest), "/tee/digest"],
      ["mode", tee.mode, "/tee/mode"],
      ["tee_sigs", tee.signatures.map((s) => b64urlOfHex(s.signature)), "/tee/signatures"],
      [
        "measurements",
        tee.attestations.map((a) => b64urlOfHex(measurementHex(a.measurement))),
        "/tee/attestations",
      ],
      ["agent_id", c.agentId, "/tee/countersign/agentId"],
      ["issued_at", rfc3339(c.issuedAt), "/tee/countersign/issuedAt"],
    ];
    for (const [key, want, source] of bound) {
      expect(sameJson(view[key], want), `${key} in the leaf is not ${source}`, [
        `/leaf_view/${key}`,
        source,
      ]);
    }
    const ref = view.paypal_ref_commit;
    const prev = view.prev_alibi_by_user;
    expect(typeof ref === "string", "the leaf has no paypal_ref_commit", [
      "/leaf_view/paypal_ref_commit",
    ]);
    const rebuilt = leafBytes({
      alibiId: input.alibi_id,
      mandateHash: c.mandateHash as Hex,
      mandateCommitment: c.mandateCommitment as Hex,
      cartHash: c.cartHash as Hex,
      evidenceRoot: c.evidenceRoot as Hex,
      evalHash: c.evalHash as Hex,
      policySetHash: c.policySetHash as Hex,
      countersignDigest: tee.digest as Hex,
      paypalRefCommit: hexOfB64url(ref),
      mode: tee.mode,
      teeSigs: tee.signatures.map((s) => s.signature as Hex) as [Hex, Hex] | [Hex],
      measurements: tee.attestations.map((a) => a.measurement) as [string, string] | [string],
      agentId: BigInt(c.agentId),
      issuedAt: Number(c.issuedAt),
      ...(typeof prev === "string" ? { prevAlibiByUser: hexOfB64url(prev) } : {}),
    });
    expect(
      rebuilt.length === bytes.length && rebuilt.every((b, i) => b === bytes[i]),
      "the leaf is not the one its sections build",
      ["/leaf", "/leaf_view"],
    );
    return pass();
  },
};
