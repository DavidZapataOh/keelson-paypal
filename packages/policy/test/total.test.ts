import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type EvalInput, evaluate, evaluateContext } from "../src/evaluate.ts";
import type { Extra } from "../src/extras.ts";
import { type Trace, traceJcs } from "../src/trace.ts";

// The JSON parsers on the Rust side reject these inputs before evaluation, so they have no
// parity line: the TS evaluator must still return a denying trace with a JCS form.

const allowed = readFileSync(new URL("./vectors/parity.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line))
  .find((c) => {
    const t = JSON.parse(Buffer.from(c.trace_jcs_hex, "hex").toString("utf8"));
    return t.decision === "allow" && c.input.extras.length === 0 && !("raw_context" in c.input);
  });

function input(): EvalInput {
  const i = structuredClone(allowed.input);
  return {
    mandate: i.mandate,
    budgetLeftMinor: i.budget_left_minor,
    agent: i.agent,
    context: i.context,
    now: new Date(i.now_ms),
    evidence: i.evidence,
    mandateHash: new Uint8Array(32),
    cartHash: new Uint8Array(32),
  };
}
const meta = () => structuredClone(allowed.input.meta);

function denied(t: Trace, errors: string[]): void {
  expect(t.decision).toBe("deny");
  expect(t.errors).toEqual(expect.arrayContaining(errors));
  expect(() => traceJcs(t)).not.toThrow();
}

describe("evaluation is total", () => {
  it("starts from an allowed case", () => {
    expect(evaluate(input(), meta()).decision).toBe("allow");
  });

  it("denies quantities that are not safe integers", () => {
    for (const q of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, -0]) {
      const i = input();
      const [variant] = i.context.quantities[0] as [never, number];
      i.context = { ...i.context, quantities: [[variant, q]] };
      denied(evaluate(i, meta()), ["context.quantities"]);
    }
  });

  it("denies lone surrogates anywhere in the input", () => {
    const cases: ((i: EvalInput) => void)[] = [
      (i) => {
        i.agent = `${i.agent}\ud800`;
      },
      (i) => {
        i.context = { ...i.context, merchant: "mrc_\udfff" };
      },
      (i) => {
        (i.mandate as { mid: string }).mid = "\ud83d";
      },
      (i) => {
        i.evidence = { total: ["ucp:\ud800"] };
      },
    ];
    for (const change of cases) {
      const i = input();
      change(i);
      denied(evaluate(i, meta()), ["request.invalid"]);
    }
    const i = input();
    const t = evaluate(i, meta(), [{ type: "deny_merchant", id: "mrc_\ud800" }]);
    denied(t, ["request.invalid"]);
    expect(t.extras_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("denies lone surrogates and prototype keys in a replayed context", () => {
    const i = input();
    const context = structuredClone(evaluate(i, meta()).context) as Record<string, unknown>;
    denied(evaluateContext(i, { ...context, currency: "\ud800" }, meta()), ["request.invalid"]);
    const proto = JSON.parse(`{"__proto__": 1, ${JSON.stringify(context).slice(1)}`);
    denied(evaluateContext(i, proto, meta()), ["context.extra:__proto__"]);
  });

  it("denies extras outside the grammar at their position", () => {
    const bad: unknown[] = [
      { type: "permit" },
      { type: "deny_merchant", id: 7 },
      { type: "max_unit_price", minor: "1" },
      { type: "deny_category", id: "gpt:1", effect: "permit" },
      null,
      "forbid(principal, action, resource);",
    ];
    for (const extra of bad) {
      const extras = [{ type: "deny_category", id: "gpt:1" }, extra] as Extra[];
      denied(evaluate(input(), meta(), extras), ["extras.invalid:1"]);
    }
  });

  it("denies a clock that is not a date", () => {
    const i = input();
    i.now = new Date(Number.NaN);
    denied(evaluate(i, meta()), ["context.type:now"]);
  });
});

describe("the sources", () => {
  it("run under plain Node, which only strips types", async () => {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", 'console.log((await import("./src/index.ts")).TRACE_VERSION)'],
      {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    expect(out.trim()).toBe("keelson.eval/1");
  });
});
