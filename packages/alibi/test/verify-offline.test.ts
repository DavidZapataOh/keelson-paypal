import { describe, expect, test } from "vitest";
import { receiptOf } from "../src/codec.ts";
import { verifyAlibi } from "../src/verify/index.ts";
import { copy, fixtures } from "./fixtures.ts";

const check = (r: Awaited<ReturnType<typeof verifyAlibi>>, id: string) =>
  r.checks.find((c) => c.id === id);

describe.each(fixtures.map((f) => [f.id, f] as const))("alibi %s", (_, f) => {
  test("replaying its policy evaluation gives the TEE's trace byte for byte", async () => {
    const report = await verifyAlibi(f.bundle);
    const replay = check(report, "policy.replay");
    expect(replay).toMatchObject({ status: "pass", step: 5 });
    expect(replay?.detail?.alert).toBeUndefined();
    expect(report.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(report.verdict).toBe("verified-offline");
    expect(report.mode).toBe(f.mode);
  });

  test("its fields table says who answers for each policy", async () => {
    const { fields } = await verifyAlibi(f.bundle);
    expect(fields.map((r) => r.id)).toEqual(
      (f.bundle.eval.fields as { id: string }[]).map((x) => x.id),
    );
    expect(fields.find((r) => r.id === "amount")).toMatchObject({
      field: "total",
      color: "green",
      answers: "Keelson",
      pass: true,
      observed: f.bundle.eval.context.total_minor,
    });
    expect(fields.find((r) => r.id === "variant")).toMatchObject({
      color: "amber",
      answers: "Agent operator",
      pass: true,
    });
  });

  test("its receipt discloses no trace to replay", async () => {
    const report = await verifyAlibi(receiptOf(f.bundle));
    expect(check(report, "policy.replay")?.status).toBe("undisclosed");
    expect(report.fields).toEqual([]);
  });

  test("a trace whose decision Cedar does not reach fails the replay", async () => {
    const b = copy(f.bundle);
    const amount = (b.eval.fields as { id: string; bound?: number }[]).find(
      (x) => x.id === "amount",
    );
    b.eval.context.total_minor = (amount?.bound ?? 0) + 1;
    const report = await verifyAlibi(b, { original: f.bundle });
    const replay = check(report, "policy.replay");
    expect(replay?.status).toBe("fail");
    expect(replay?.reason).toContain("decides deny");
    expect(replay?.blame).toEqual(["/eval/context/total_minor"]);
    expect(report.verdict).toBe("failed");
  });

  test("a trace that differs only beyond decision and fired passes with an alert", async () => {
    const b = copy(f.bundle);
    const row = (b.eval.fields as { id: string; color: string }[]).find((x) => x.id === "variant");
    if (row) row.color = "green";
    const report = await verifyAlibi(b);
    const replay = check(report, "policy.replay");
    expect(replay?.status).toBe("pass");
    expect(replay?.detail?.alert).toContain("the TEE's trace stands");
    expect(check(report, "tee.countersign")?.status).toBe("fail");
  });
});
