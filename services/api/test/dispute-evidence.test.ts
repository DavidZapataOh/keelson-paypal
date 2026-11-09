import { describe, expect, test } from "vitest";
import { ALIBI_FILE, nextStep, responsePlan } from "../src/disputes/evidence.ts";

const types = (ruleId: number, liable: number, order = {}) => {
  const plan = responsePlan({ ruleId, liable }, order);
  return plan.action === "contest" ? plan.evidences.map((e) => e.evidence_type) : plan.action;
};

describe("responsePlan", () => {
  test("the user at fault: the mandate they signed and the Alibi", () => {
    for (const rule of [32, 62, 70]) {
      expect(types(rule, 4)).toEqual(["PERMISSION_DESCRIPTION", "ORDER_DETAILS"]);
    }
    const plan = responsePlan({ ruleId: 70, liable: 4 });
    expect(plan).toMatchObject({ action: "contest", party: "user" });
    if (plan.action !== "contest") throw new Error("unreachable");
    expect(plan.evidences[1]?.documents).toEqual([{ name: ALIBI_FILE }]);
    expect(plan.evidences[0]?.documents).toBeUndefined();
  });

  test("delivery and refund rules cite PayPal's own records", () => {
    expect(types(10, 4)).toEqual(["ONLINE_TRACKING_INFORMATION", "ORDER_DETAILS"]);
    const order = { purchaseUnits: [{ payments: { refunds: [{ id: "1JU08902781691411" }] } }] };
    const plan = responsePlan({ ruleId: 20, liable: 4 }, order);
    if (plan.action !== "contest") throw new Error("unreachable");
    expect(plan.evidences[0]).toEqual({
      evidence_type: "PROOF_OF_REFUND",
      evidence_info: { refund_ids: ["1JU08902781691411"] },
    });
    expect(() => responsePlan({ ruleId: 20, liable: 4 })).toThrow(/refund/);
  });

  test("the merchant at fault: the Alibi shows the agent complied", () => {
    for (const rule of [11, 21, 35, 40, 50]) expect(types(rule, 3)).toEqual(["ORDER_DETAILS"]);
  });

  test("the operator or Keelson at fault: the claim is accepted", () => {
    for (const [rule, liable] of [
      [0, 1],
      [31, 1],
      [61, 1],
      [30, 2],
      [60, 2],
    ] as const) {
      expect(types(rule, liable)).toBe("accept");
    }
  });

  test("an unknown rule or party has no response", () => {
    expect(() => responsePlan({ ruleId: 99, liable: 4 })).toThrow();
    expect(() => responsePlan({ ruleId: 70, liable: 0 })).toThrow();
  });
});

describe("nextStep", () => {
  const contest = responsePlan({ ruleId: 70, liable: 4 });
  const accept = responsePlan({ ruleId: 61, liable: 1 });
  const links = (...rels: string[]) => rels.map((rel) => ({ rel }));

  test("evidence once PayPal asks for it, a message during the inquiry", () => {
    expect(nextStep(contest, links("self", "accept_claim", "provide_evidence"))).toBe(
      "provide_evidence",
    );
    expect(nextStep(contest, links("self", "send_message", "escalate"))).toBe("send_message");
    expect(nextStep(contest, links("self", "accept_claim"))).toBeNull();
  });

  test("a claim is accepted only where PayPal offers it", () => {
    expect(nextStep(accept, links("self", "accept_claim", "provide_evidence"))).toBe(
      "accept_claim",
    );
    expect(nextStep(accept, links("self"))).toBeNull();
  });
});
