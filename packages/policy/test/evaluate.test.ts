import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentUid, mandateAgent } from "../src/entity.ts";
import { type EvalInput, evaluate } from "../src/evaluate.ts";
import { traceJcs } from "../src/trace.ts";

const allowed = readFileSync(new URL("./vectors/parity.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line))
  .find((c) => {
    const t = JSON.parse(Buffer.from(c.trace_jcs_hex, "hex").toString("utf8"));
    return t.decision === "allow" && c.input.extras.length === 0 && !("raw_context" in c.input);
  });
const meta = () => structuredClone(allowed.input.meta);

function input(): EvalInput {
  const i = structuredClone(allowed.input);
  const op = i.mandate.agent.operator;
  return {
    mandate: i.mandate,
    budgetLeftMinor: i.budget_left_minor,
    // The authenticated requester: here the agent the mandate names.
    agent: agentUid(op.agent_registry, op.agent_id) as string,
    context: i.context,
    now: new Date(i.now_ms),
    evidence: i.evidence,
    mandateHash: new Uint8Array(32),
    cartHash: new Uint8Array(32),
  };
}

describe("the requesting agent", () => {
  it("is a canonical uid", () => {
    expect(agentUid("reg/with/slashes", "0")).toBe("reg/with/slashes/0");
    for (const id of ["", "042", "4a", "-1", "+5", "٣"]) expect(agentUid("r", id)).toBeUndefined();
  });

  it("is denied when another agent than the mandate's is authenticated", () => {
    const i = input();
    expect(i.agent).toBe(mandateAgent(i.mandate));
    expect(evaluate(i, meta()).decision).toBe("allow");
    const op = (i.mandate as { agent: { operator: { agent_registry: string } } }).agent.operator;
    i.agent = agentUid(op.agent_registry, "999999") as string;
    const t = evaluate(i, meta());
    expect(t.decision).toBe("deny");
    expect(t.fired).toEqual(["agent"]);
  });
});

describe("attribute errors", () => {
  it("name the first unsupported key in byte order, whatever the key order", () => {
    const withMust = (must: string) => {
      const i = input();
      const checkout = (i.mandate as { checkout: { constraints: { type: string }[] } }).checkout;
      checkout.constraints = [
        ...checkout.constraints.filter((c) => c.type !== "keelson.attributes"),
        { type: "keelson.attributes", must: JSON.parse(must) } as { type: string },
      ];
      return evaluate(i, meta());
    };
    for (const [a, b, field] of [
      ['{"fit":"x","10":"y"}', '{"10":"y","fit":"x"}', "10"],
      ['{"size_us":"10","width":1,"fit":"x"}', '{"width":1,"fit":"x","size_us":"10"}', "fit"],
      ['{"é":"x","z":"y"}', '{"z":"y","é":"x"}', "z"],
    ] as const) {
      const t = withMust(a);
      expect(t.errors).toEqual([`entity.invalid:keelson.attributes.must.${field}`]);
      expect(traceJcs(t)).toEqual(traceJcs(withMust(b)));
    }
  });
});
