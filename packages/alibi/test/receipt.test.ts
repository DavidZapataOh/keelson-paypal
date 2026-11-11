import { describe, expect, test } from "vitest";
import { toBase64, toBase64url } from "../src/b64.ts";
import { leafHashOf } from "../src/codec.ts";
import type { AlibiReceipt } from "../src/schema.ts";
import { verifyAlibi } from "../src/verify/index.ts";
import { leaves, receipts } from "./log-receipts.ts";

describe("receipts of real log leaves", () => {
  test("the tile holds the 54 leaves the checkpoint commits to", () => {
    expect(leaves).toHaveLength(54);
    expect(receipts.length).toBeGreaterThan(0);
  });

  test.each(receipts.map((r) => [r.alibi_id, r] as const))(
    "%s: included, witnessed, nothing else disclosed",
    async (_, r) => {
      expect(toBase64url(leafHashOf(r))).toBe(r.leaf_hash);
      const report = await verifyAlibi(r, { now: new Date("2026-11-09T07:00:00Z") });
      const status = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
      expect(status).toEqual({
        "bundle.format": "pass",
        "leaf.view": "pass",
        "qr.leaf": "absent",
        "mandate.challenge": "undisclosed",
        "mandate.passkey": "undisclosed",
        "mandate.credentials": "undisclosed",
        "tee.attestation.tdx": "undisclosed",
        "tee.attestation.nitro": "undisclosed",
        "tee.countersign": "undisclosed",
        "tee.registry": "undisclosed",
        "log.policy": "undisclosed",
        "log.inclusion": "pass",
        "log.witnesses": "pass",
        "anchor.consistency": "pending",
        "anchor.root": "pending",
        "anchor.tx": "pending",
        timestamps: "pending",
        "zk.c1": "absent",
        "zk.c3": "absent",
        "evidence.manifest": "undisclosed",
        "evidence.web_fact": "undisclosed",
        "evidence.checkout": "undisclosed",
        "evidence.conversion": "undisclosed",
        "paypal.ids": "undisclosed",
        "card.authorizations": "undisclosed",
        "card.statements": "absent",
        "rats.cmw": "absent",
        "scitt.receipt": "absent",
        "scitt.statement": "absent",
        "policy.replay": "undisclosed",
      });
      expect(report.verdict).toBe("incomplete");
    },
  );

  const r = receipts[0] as AlibiReceipt;
  test("a leaf of another alibi, a proof hash or a missing cosignature fails its check", async () => {
    const other = receipts[1] as AlibiReceipt;
    const swapped = await verifyAlibi({ ...r, leaf: other.leaf, leaf_hash: other.leaf_hash });
    expect(swapped.checks.find((c) => c.id === "leaf.view")?.status).toBe("fail");

    const lines = r.tlog_proof.split("\n");
    lines[2] = toBase64(new Uint8Array(32));
    const bad = await verifyAlibi({ ...r, tlog_proof: lines.join("\n") });
    expect(bad.checks.find((c) => c.id === "log.inclusion")).toMatchObject({
      status: "fail",
      reason: "not included",
      reads: ["/tlog_proof", "/leaf"],
    });

    const cosigs = r.tlog_proof.split("\n").filter((l) => l.startsWith("— witness-"));
    const one = cosigs.slice(1).reduce((p, l) => p.replace(`${l}\n`, ""), r.tlog_proof);
    const unwitnessed = await verifyAlibi({ ...r, tlog_proof: one });
    expect(unwitnessed.checks.find((c) => c.id === "log.witnesses")).toMatchObject({
      status: "fail",
      reason: "1 of 2",
    });
    expect(unwitnessed.verdict).toBe("failed");
  });
});
