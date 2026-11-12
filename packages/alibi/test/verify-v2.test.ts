import { describe, expect, test } from "vitest";
import { receiptOf } from "../src/codec.ts";
import type { Check } from "../src/verify/index.ts";
import { earOf, verifyAlibi } from "../src/verify/index.ts";
import { receiptKeys, v2Bundle } from "./v2.ts";

const now = new Date("2026-11-10T00:00:00Z");
const statusOf = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.id, c.status]));

describe("verifying a v2 Alibi", () => {
  test("the bundle: the statement, the evidence and every preimage check out", async () => {
    const r = await verifyAlibi(v2Bundle(), { now, receiptKeys });
    const s = statusOf(r.checks);
    for (const id of [
      "bundle.format",
      "scitt.statement",
      "rats.cmw",
      "mandate.challenge",
      "mandate.passkey",
      "mandate.credentials",
      "policy.replay",
      "evidence.manifest",
      "paypal.ids",
      "log.policy",
    ]) {
      expect(s[id], id).toBe("pass");
    }
    expect(s["leaf.view"]).toBe("absent");
    expect(r.mode).toBe("2of2");
  });

  test("the test legs are not the attested signers, and the verifier says so", async () => {
    const r = await verifyAlibi(v2Bundle(), { now, receiptKeys });
    const c = r.checks.find((x) => x.id === "tee.countersign");
    expect(c?.status).toBe("fail");
    expect(c?.reason).toBe("not the attested signer");
    expect(c?.reads.every((p) => p === "/statement" || p.startsWith("/attestation"))).toBe(true);
  });

  test("a bare statement: the statement and its receipt verify, the log proof is undisclosed", async () => {
    const b = v2Bundle();
    const { tlog_proof: _, ...bare } = receiptOf(b);
    const r = await verifyAlibi(bare, { now, receiptKeys });
    const s = statusOf(r.checks);
    expect(s["scitt.statement"]).toBe("pass");
    expect(s["scitt.receipt"]).toBe("pass");
    expect(s["log.inclusion"]).toBe("undisclosed");
    expect(s["log.witnesses"]).toBe("undisclosed");
    expect(s["rats.cmw"]).toBe("undisclosed");
  });

  test("a receipt key that is not pinned fails the receipt", async () => {
    const { tlog_proof: _, ...bare } = receiptOf(v2Bundle());
    const r = await verifyAlibi(bare, { now, receiptKeys: new Map() });
    expect(statusOf(r.checks)["scitt.receipt"]).toBe("fail");
  });

  test("v1 Alibis report the three new checks as absent", async () => {
    const { fixtures } = await import("./fixtures.ts");
    const r = await verifyAlibi((fixtures[0] as { bundle: never } | undefined)?.bundle as never, {
      now,
    });
    const s = statusOf(r.checks);
    expect([s["scitt.statement"], s["scitt.receipt"], s["rats.cmw"]]).toEqual([
      "absent",
      "absent",
      "absent",
    ]);
  });

  test("EAR: one appraisal per leg", async () => {
    const r = await verifyAlibi(v2Bundle(), { now, receiptKeys });
    const ear = earOf(r, now) as {
      eat_profile: string;
      submods: Record<string, { ear_status: string }>;
    };
    expect(ear.eat_profile).toBe("tag:ietf.org,2026:rats/ear#05");
    expect(Object.keys(ear.submods)).toEqual(["tdx", "nitro"]);
    for (const leg of ["tdx", "nitro"]) {
      const c = r.checks.find((x) => x.id === `tee.attestation.${leg}`);
      expect(ear.submods[leg]?.ear_status).toBe(
        c?.status === "pass" ? "affirming" : "contraindicated",
      );
    }
  });
});
