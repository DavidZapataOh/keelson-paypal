"use client";

import { keelsonStudioTheme } from "@keelson/ui/studio";
import {
  type AgAiHarnessSetup,
  type AgAiModel,
  type AgAiPromptStarter,
  type AgPanelConfig,
  type AgReportState,
  AgStudioAiModule,
  type AgStudioApi,
  createAiHarness,
  directLlmRunner,
} from "ag-studio";
import { AgStudio, AgStudioProvider, createWidgets } from "ag-studio-react";
import { useMemo, useState } from "react";
import { anthropicAdapter } from "../../lib/anthropic-adapter";
import { API } from "../../lib/config";
import { assistantEndpoint, type Evaluations, type MerchantDispute } from "../../lib/merchant";
import { type ConsoleContext, DisputeClock } from "./dispute-widget";
import { FieldAttributionMatrix } from "./matrix-widget";
import type { Registry } from "./registry";
import { disputeRows, evaluationRows, sources } from "./sources";

const MODELS: AgAiModel[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
];

const title = (text: string) => ({
  title: { enabled: true, text, typography: { fontSize: 14, fontWeight: "bold" as const } },
});

/** The two pages a merchant opens on: the dispute queue and the forensics matrix. */
const REPORT: AgReportState<Registry> = {
  selectedPageId: "disputes",
  panels: { filters: { collapsed: true }, ai: { collapsed: false } },
  pages: [
    {
      id: "disputes",
      widgets: {
        "kpi-disputes": {
          type: "value",
          dataMapping: { value: [{ id: "disputes.disputes", aggregation: "sum" }] },
          format: title("Disputes"),
        },
        "kpi-amount": {
          type: "value",
          dataMapping: { value: [{ id: "disputes.amount", aggregation: "sum" }] },
          format: title("Amount disputed"),
        },
        "kpi-verdict": {
          type: "value",
          dataMapping: { value: [{ id: "disputes.minutes_to_verdict", aggregation: "avg" }] },
          format: title("Average minutes to verdict"),
        },
        "filter-outcome": {
          type: "button-filter",
          dataMapping: { value: [{ id: "disputes.outcome" }] },
          format: title("Outcome"),
        },
        "filter-liable": {
          type: "button-filter",
          dataMapping: { value: [{ id: "disputes.liable" }] },
          format: title("Liable"),
        },
        queue: {
          type: "grid",
          dataMapping: {
            cols: [
              { id: "disputes.amount", aggregation: "sum" },
              { id: "disputes.outcome" },
              { id: "disputes.liable" },
              { id: "disputes.rule" },
              { id: "disputes.paid_by" },
              { id: "disputes.rail" },
              { id: "disputes.minutes_to_verdict", aggregation: "sum" },
              { id: "disputes.dispute_id" },
              { id: "disputes.received_at" },
              { id: "disputes.agent" },
              { id: "disputes.alibi" },
            ],
          },
          format: title("Dispute queue"),
        },
        clock: {
          type: "dispute-clock",
          dataMapping: { dispute: [{ id: "disputes.dispute_id" }] },
          format: title("Dispute to verdict"),
        },
      },
      widgetLayout: {
        "kpi-disputes": { xTrack: 0, yTrack: 0, xSpan: 5, ySpan: 10 },
        "kpi-amount": { xTrack: 5, yTrack: 0, xSpan: 5, ySpan: 10 },
        "kpi-verdict": { xTrack: 10, yTrack: 0, xSpan: 5, ySpan: 10 },
        "filter-outcome": { xTrack: 15, yTrack: 0, xSpan: 9, ySpan: 5 },
        "filter-liable": { xTrack: 15, yTrack: 5, xSpan: 9, ySpan: 5 },
        queue: { xTrack: 0, yTrack: 10, xSpan: 16, ySpan: 26 },
        clock: { xTrack: 16, yTrack: 10, xSpan: 8, ySpan: 26 },
      },
    },
    {
      id: "forensics",
      widgets: {
        matrix: {
          type: "field-attribution-matrix",
          dataMapping: {
            row: [{ id: "evaluations.field" }],
            column: [{ id: "evaluations.agent" }],
            value: [{ id: "evaluations.failed", aggregation: "sum" }],
          },
          format: title("Failed checks by mandate field and agent"),
        },
        "filter-source": {
          type: "button-filter",
          dataMapping: { value: [{ id: "evaluations.source" }] },
          format: title("Source"),
        },
        "filter-decision": {
          type: "button-filter",
          dataMapping: { value: [{ id: "evaluations.decision" }] },
          format: title("Keelson's decision"),
        },
        "by-agent": {
          type: "bar-chart-grouped",
          dataMapping: {
            categoryKey: [{ id: "evaluations.agent" }],
            valueKey: [{ id: "evaluations.failed", aggregation: "sum" }],
          },
          format: title("Failed checks by agent"),
        },
        evaluations: {
          type: "grid",
          dataMapping: {
            cols: [
              { id: "evaluations.at" },
              { id: "evaluations.agent" },
              { id: "evaluations.field" },
              { id: "evaluations.decision" },
              { id: "evaluations.source" },
              { id: "evaluations.attack_class" },
              { id: "evaluations.dispute_id" },
              { id: "evaluations.evaluation_id" },
              { id: "evaluations.failed" },
            ],
          },
          format: title("Evaluations"),
        },
      },
      widgetLayout: {
        matrix: { xTrack: 0, yTrack: 0, xSpan: 16, ySpan: 20 },
        "filter-source": { xTrack: 16, yTrack: 0, xSpan: 8, ySpan: 6 },
        "filter-decision": { xTrack: 16, yTrack: 6, xSpan: 8, ySpan: 6 },
        "by-agent": { xTrack: 16, yTrack: 12, xSpan: 8, ySpan: 8 },
        evaluations: { xTrack: 0, yTrack: 20, xSpan: 24, ySpan: 18 },
      },
    },
  ],
};

/** The assistant and the filters, the two panels a merchant works with; the builder's stay hidden. */
const PANELS: AgPanelConfig = { edit: { right: ["ai", "filters"] } };

const PROMPTS: AgAiPromptStarter[] = [
  {
    label: "Why did we lose a dispute?",
    prompt:
      "Why did we lose our latest dispute, and which agents fail most on price? Show me the filtered matrix.",
  },
  { label: "Who pays most often", prompt: "Which party is liable most often in our disputes?" },
  { label: "Slowest verdicts", prompt: "Which disputes took longest to reach a verdict?" },
];

const FORENSICS = `You are the forensics agent of a PayPal merchant's Keelson console. Keelson countersigns AI agents' purchases against the buyer's signed mandate, then attributes PayPal disputes with a verdict both TEEs sign: who is liable (the agent's operator, Keelson, the merchant or the buyer), under which rule, and who paid the merchant.
To explain a dispute, call explain_dispute with its id (PP-D-...) and answer from what it returns: the rule, the liable party, the facts (which mandate fields failed and how they were observed) and the settlement. Never guess a fact the tool did not return.
To show where agents fail, call open_page with "forensics", then filter that page with add_page_filter on the evaluations table: "Mandate field" = "Price (cart total)" for price, and "Failed checks" > 0 when asked for failures. Use execute_query on the evaluations table to rank agents by the sum of "Failed checks" and quote the numbers.
Close with one line naming every filter you applied, so the merchant can remove them.`;

/**
 * The merchant console's Studio: its two pages over the merchant's real disputes and evaluations,
 * the field-attribution matrix and the dispute clock, and the agents (a lead of our own that
 * delegates to Studio's planning, data, page and widget agents and to `forensics`).
 */
export default function MerchantStudio({
  merchantId,
  disputes,
  evaluations,
  onModel,
  onApi,
  onPage,
}: {
  onApi: (api: AgStudioApi) => void;
  onPage: (pageId: string) => void;
  merchantId: string;
  disputes: readonly MerchantDispute[];
  evaluations: Evaluations;
  onModel: (model: string) => void;
}) {
  const data = useMemo(
    () => sources(disputeRows(disputes), evaluationRows(evaluations)),
    [disputes, evaluations],
  );
  const context = useMemo<ConsoleContext>(
    () => ({ disputes: new Map(disputes.map((d) => [d.dispute_id, d])) }),
    [disputes],
  );
  const [modules] = useState(() => [AgStudioAiModule]);
  // On a phone the assistant would cover the report: it opens folded.
  const [initial] = useState<AgReportState<Registry>>(() =>
    matchMedia("(max-width: 767px)").matches
      ? { ...REPORT, panels: { ...REPORT.panels, ai: { collapsed: true } } }
      : REPORT,
  );
  const widgets = useMemo(
    () =>
      createWidgets<Registry>({
        additionalTypes: [
          {
            id: "field-attribution-matrix",
            label: "Field attribution matrix",
            dataMapping: {
              row: {
                type: "field",
                supportedRoles: ["category"],
                required: true,
                aiDescription: "Rows: the mandate field.",
              },
              column: {
                type: "field",
                supportedRoles: ["category"],
                required: true,
                aiDescription: "Columns: the agent.",
              },
              value: {
                type: "field",
                supportedRoles: ["numeric"],
                requires: { per: "dataMapping.row", cardinality: "one" },
                required: true,
                aiDescription: "The measure in each cell, such as the sum of failed checks.",
              },
            },
            form: (p) =>
              p.createDefaults({
                dataMappingItems: [
                  { key: "row", label: "Rows" },
                  { key: "column", label: "Columns" },
                  { key: "value", label: "Value" },
                ],
              }),
            comp: FieldAttributionMatrix,
            defaultSize: { width: 720, height: 420 },
            minSize: { width: 360, height: 240 },
            ai: {
              description:
                "Heatmap of a measure over two dimensions, typically failed mandate checks by mandate field (rows) and agent (columns). Selecting a cell, row or column cross-filters the page.",
              usage: "Answer which agents fail most on a mandate field such as price.",
            },
          },
          {
            id: "dispute-clock",
            label: "Dispute to verdict",
            dataMapping: {
              dispute: {
                type: "field",
                supportedRoles: ["category"],
                required: true,
                aiDescription: "The dispute id.",
              },
            },
            form: (p) =>
              p.createDefaults({ dataMappingItems: [{ key: "dispute", label: "Dispute" }] }),
            comp: DisputeClock,
            defaultSize: { width: 360, height: 420 },
            minSize: { width: 280, height: 240 },
            ai: {
              description:
                "One dispute's path from PayPal's dispute to Keelson's signed verdict and the payout, with links to verify its Alibi and settlement transaction. Follows the page's filters.",
            },
          },
        ],
        menu: [{ label: "Keelson", widgetIds: ["field-attribution-matrix", "dispute-clock"] }],
      }),
    [],
  );

  const ai = useMemo<AgAiHarnessSetup>(() => {
    const adapter = anthropicAdapter({ endpoint: assistantEndpoint(merchantId), onModel });
    return ({ api: core }) => {
      // The setup hands the core API; the instance is the full Studio API.
      const api = core as unknown as AgStudioApi<Registry>;
      const studio = api.getAiTools();
      const explainDispute = api.defineAiTool({
        name: "explain_dispute",
        description:
          "Read a dispute's signed verdict from Keelson: rule, liable party, the facts both TEEs attributed, and how the merchant was paid.",
        params: (s) =>
          s.object({ dispute_id: s.string({ description: "The PayPal dispute id, PP-D-..." }) }),
        execute: async ({ dispute_id }: { dispute_id: string }, ctx) => {
          const res = await fetch(`${API}/v1/disputes/${encodeURIComponent(dispute_id)}`, {
            signal: ctx.signal,
          });
          if (!res.ok) return ctx.error(`No dispute ${dispute_id} over a Keelson purchase.`);
          const d = (await res.json()) as Record<string, unknown> & {
            verdict: { facts: unknown; rule: string } | null;
          };
          const row = context.disputes.get(dispute_id);
          return ctx.success(
            JSON.stringify({
              dispute_id,
              state: d.state,
              reason: d.reason,
              liable: d.liable,
              rule: d.verdict?.rule ?? null,
              facts: d.verdict?.facts ?? null,
              settlement: d.settlement,
              elapsed_ms: d.elapsed_ms,
              agent: row ? `Agent #${row.agent_id}` : null,
              alibi: row?.has_alibi ? `https://verify.keelson.finance/a/${row.purchase_id}` : null,
            }),
          );
        },
      });
      const openPage = api.defineAiTool({
        name: "open_page",
        description: "Show one of the console's pages: the dispute queue or the forensics matrix.",
        params: (s) => s.object({ page: s.enum(["disputes", "forensics"]) }),
        execute: ({ page }: { page: "disputes" | "forensics" }, ctx) => {
          api.setState({ ...api.getState(), selectedPageId: page });
          return ctx.success(`Showing the ${page} page.`);
        },
      });
      return createAiHarness(core as unknown as AgStudioApi, ({ builtIn, tools }) => {
        const specialists = (["planning", "data", "page", "widget"] as const).map((id) =>
          directLlmRunner({ ...builtIn[id], adapter }),
        );
        const forensics = directLlmRunner({
          id: "forensics",
          adapter,
          description:
            "Explains why a dispute was won or lost from its signed verdict, and filters the forensics matrix to show which agents fail on which mandate fields.",
          schema: (s) => s.undefined(),
          instructions: () => FORENSICS,
          tools: () => [
            explainDispute,
            openPage,
            studio.viewSchema(),
            studio.viewPage(),
            studio.executeQuery(),
            studio.addPageFilter(),
            studio.removePageFilter(),
          ],
        });
        const lead = directLlmRunner({
          ...builtIn.lead,
          adapter,
          instructions: (ctx, params) =>
            `${builtIn.lead.instructions?.(ctx, params) ?? ""}\n\nThis is a merchant's Keelson console. Hand any question about a dispute, a verdict, liability or which agents fail on which mandate fields to the forensics agent; hand dashboard building to your other specialists.`,
          tools: (ctx, params) => [
            ...(builtIn.lead.tools?.(ctx, params) ?? []).filter((t) => t.name !== "delegate_to"),
            tools.delegateTo(["planning", "data", "page", "widget", "forensics"]),
          ],
        });
        return {
          agents: [lead, ...specialists, forensics],
          primary: "lead",
          models: MODELS,
          promptStarters: PROMPTS,
        };
      });
    };
  }, [merchantId, onModel, context]);

  return (
    <AgStudioProvider modules={modules}>
      <AgStudio<Registry>
        className="h-full w-full"
        data={data}
        context={context}
        initialState={initial}
        widgets={widgets}
        theme={keelsonStudioTheme}
        mode="edit"
        panels={PANELS}
        ai={ai}
        onApiReady={(e) => onApi(e.api)}
        onStateUpdated={(e) => onPage(e.api.getState().selectedPageId)}
      />
    </AgStudioProvider>
  );
}
