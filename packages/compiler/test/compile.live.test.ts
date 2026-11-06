import { readFileSync } from "node:fs";
import { type Mandate, parseMandate } from "@keelson/mandate";
import { afterAll, describe, expect, it } from "vitest";
import { type CompileResult, compileMandate } from "../src/compile.ts";
import type { SystemFields } from "../src/diff.ts";

const demo: Mandate = parseMandate(
  JSON.parse(
    readFileSync(new URL("../../mandate/test/fixtures/demo-mandate.json", import.meta.url), "utf8"),
  ),
);

/** Wednesday 2026-11-04T00:00:00Z: the next Friday is 2026-11-06. */
const system: SystemFields = {
  mid: demo.mid,
  iat: demo.iat,
  nonce: demo.nonce,
  mode: demo.mode,
  user: demo.user,
  agent: demo.agent,
  consent: demo.consent,
  policy: demo.policy,
  risk_data: demo.risk_data,
  merchants: [
    {
      id: "mrc_runfast",
      name: "RunFast",
      website: "https://runfast.example",
      paypal_merchant_id: "MERCH7XK2Q9LD",
    },
    {
      id: "mrc_trailhub",
      name: "Trail Hub",
      website: "https://www.trailhub.example",
      paypal_merchant_id: "MERCH2TRAILHB",
    },
  ],
};

const PROMPT = "Running shoes, size 10, under $100, free returns, by Friday";
const usage: CompileResult["usage"] = [];
afterAll(() => console.table(usage));

type Constraint =
  | Mandate["checkout"]["constraints"][number]
  | Mandate["payment"]["constraints"][number];
const constraint = <T extends Constraint["type"]>(cs: readonly Constraint[], type: T) =>
  cs.find((c) => c.type === type) as Extract<Constraint, { type: T }>;

describe("compileMandate", { timeout: 300_000 }, () => {
  it("compiles the demo request with both models", async () => {
    const r = await compileMandate(PROMPT, system);
    usage.push(...r.usage);
    expect(r.sources.opus).toEqual({ status: "ok" });
    expect(r.sources.sonnet).toEqual({ status: "ok" });
    expect(r.sources.haiku.status).toBe("ok");
    if (!r.ok) throw r.error;
    console.log("ambiguous:", r.ambiguous, "discrepancies:", r.discrepancies);
    const m = r.mandate;
    expect(m.payment.currency).toBe("USD");
    expect(constraint(m.payment.constraints, "payment.amount_range").max).toBe(10000);
    expect(constraint(m.checkout.constraints, "keelson.attributes").must.size_us).toBe("10");
    expect(constraint(m.checkout.constraints, "keelson.returns").free).toBe(true);
    expect(constraint(m.payment.constraints, "payment.execution_date").not_after.slice(0, 10)).toBe(
      "2026-11-06",
    );
    expect(r.singleSource).toBe(false);
    expect(r.card.rows.find((row) => row.field === "total")?.values).toEqual(["100.00 USD"]);
  });

  it("compiles from one model when the other times out, with every field ambiguous", async () => {
    const r = await compileMandate(PROMPT, system, { limits: { sonnet: { timeout: 1 } } });
    usage.push(...r.usage);
    expect(r.sources.sonnet).toEqual({ status: "failed", reason: "timeout" });
    expect(r.sources.opus).toEqual({ status: "ok" });
    if (!r.ok) throw r.error;
    expect(r.singleSource).toBe(true);
    const compiled = r.card.rows.filter((row) => r.ambiguous.includes(row.field));
    expect(r.ambiguous).toEqual([
      "currency",
      "total",
      "budget",
      "merchant",
      "category",
      "variant",
      "return_policy",
      "deadline",
      "quantity",
      "items",
      "subjective",
    ]);
    for (const row of compiled) expect(row.color).toBe("gray");
  });

  it("reports a model cut off by max_tokens as failed", async () => {
    const r = await compileMandate(PROMPT, system, { limits: { sonnet: { maxTokens: 64 } } });
    usage.push(...r.usage);
    expect(r.sources.sonnet).toEqual({ status: "failed", reason: "max_tokens" });
    expect(r.sources.opus).toEqual({ status: "ok" });
    expect(r.ok && r.singleSource).toBe(true);
  });
});
