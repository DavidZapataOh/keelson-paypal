import type { AgDataSourcesDefinition } from "ag-studio";
import { major } from "../../lib/format";
import type { Evaluations, MerchantDispute } from "../../lib/merchant";
import { FIELD, LIABLE, OUTCOME, PAID_BY_SHORT, RAIL } from "./labels";
import type { Registry } from "./registry";

const money = { format: "currencyFormat", formatOptions: { format: "$#,##0.00" } } as const;

export function disputeRows(disputes: readonly MerchantDispute[]) {
  return disputes.map((d) => ({
    dispute_id: d.dispute_id,
    received_at: d.received_at ? new Date(d.received_at) : null,
    amount: major(d.amount_minor, d.currency),
    outcome: OUTCOME[d.outcome ?? "open"].text,
    liable: d.liable ? LIABLE[d.liable] : "Pending",
    rule: d.rule ?? "",
    paid_by: d.paid_by ? PAID_BY_SHORT[d.paid_by] : "",
    rail: d.rail ? RAIL[d.rail] : "",
    minutes_to_verdict: d.elapsed_ms === null ? null : d.elapsed_ms / 60_000,
    reason: d.reason.toLowerCase().replaceAll("_", " "),
    agent: `Agent #${d.agent_id}`,
    alibi: d.has_alibi ? d.purchase_id : "",
    disputes: 1,
  }));
}

export function evaluationRows({ columns, rows }: Evaluations) {
  const at = (name: string) => columns.indexOf(name);
  const [source, id, when, agent, field, decision, attackClass, dispute, failed] = [
    "source",
    "evaluation_id",
    "at",
    "agent",
    "field",
    "decision",
    "attack_class",
    "dispute_id",
    "failed",
  ].map(at) as number[];
  return rows.map((r) => ({
    source: r[source as number] === "red-team" ? "Red-team attack" : "Purchase",
    evaluation_id: r[id as number],
    at: new Date(String(r[when as number])),
    agent: r[agent as number],
    field: FIELD[String(r[field as number])] ?? String(r[field as number]),
    decision: r[decision as number] === "deny" ? "Blocked" : "Allowed",
    attack_class: r[attackClass as number] ?? "",
    dispute_id: r[dispute as number] ?? "",
    failed: Number(r[failed as number]),
    checks: 1,
  }));
}

export function sources(
  disputes: ReturnType<typeof disputeRows>,
  evaluations: ReturnType<typeof evaluationRows>,
): AgDataSourcesDefinition<Registry> {
  return {
    sources: [
      {
        id: "disputes",
        name: "Disputes",
        data: disputes,
        fields: [
          { id: "dispute_id", name: "Dispute", format: "textFormat" },
          { id: "received_at", name: "Opened", format: "dateTimeFormat" },
          { id: "amount", name: "Amount", ...money },
          { id: "outcome", name: "Outcome", format: "textFormat" },
          { id: "liable", name: "Liable", format: "textFormat" },
          { id: "rule", name: "Rule", format: "textFormat" },
          { id: "paid_by", name: "Paid by", format: "textFormat" },
          { id: "rail", name: "Rail", format: "textFormat" },
          {
            id: "minutes_to_verdict",
            name: "Minutes to verdict",
            format: "decimalFormat",
            formatOptions: { format: "#,##0.0" },
          },
          { id: "reason", name: "PayPal reason", format: "textFormat" },
          { id: "agent", name: "Agent", format: "textFormat" },
          { id: "alibi", name: "Alibi", format: "textFormat" },
          { id: "disputes", name: "Disputes", format: "integerFormat" },
        ],
      },
      {
        id: "evaluations",
        name: "Evaluations",
        data: evaluations,
        fields: [
          { id: "source", name: "Source", format: "textFormat" },
          { id: "evaluation_id", name: "Evaluation", format: "textFormat" },
          { id: "at", name: "Evaluated", format: "dateTimeFormat" },
          { id: "agent", name: "Agent", format: "textFormat" },
          { id: "field", name: "Mandate field", format: "textFormat" },
          { id: "decision", name: "Decision", format: "textFormat" },
          { id: "attack_class", name: "Attack class", format: "textFormat" },
          { id: "dispute_id", name: "Dispute", format: "textFormat" },
          { id: "failed", name: "Failed checks", format: "integerFormat" },
          { id: "checks", name: "Checks", format: "integerFormat" },
        ],
      },
    ],
  };
}
