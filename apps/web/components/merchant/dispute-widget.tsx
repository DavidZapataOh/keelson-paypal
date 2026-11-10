import { Amount } from "@keelson/ui/components/amount";
import type { AgWidgetFieldReference, AgWidgetParams } from "ag-studio";
import { AgIncompleteDataMappingOverlay, AgNoDataOverlay } from "ag-studio-react";
import { use } from "react";
import { VERIFY } from "../../lib/config";
import type { MerchantDispute } from "../../lib/merchant";
import { LIABLE, OUTCOME, PAID_BY, RAIL } from "./labels";

export interface DisputeDef {
  type: "dispute-clock";
  format?: { title?: { enabled?: boolean; text?: string } };
  dataMapping: { dispute: AgWidgetFieldReference[] };
}

/** The application context Studio hands every widget: the disputes behind the page's rows. */
export interface ConsoleContext {
  disputes: ReadonlyMap<string, MerchantDispute>;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} days`;
}

const time = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

function Event({ when, children }: { when: string | null; children: React.ReactNode }) {
  return (
    <li className="relative grid gap-0.5 pl-5 before:absolute before:top-1.5 before:left-0 before:size-2 before:rounded-full before:border before:border-foreground">
      <span>{children}</span>
      {when ? (
        <time dateTime={when} className="text-muted-foreground text-xs">
          {time(when)}
        </time>
      ) : null}
    </li>
  );
}

/**
 * One dispute from Dispute to verdict to payout: the time Keelson took to attribute it, who was
 * liable under which rule, who paid, and the checks outside the app (the Alibi, the transaction).
 * It follows the page's filters: select a row in the queue to pick the dispute.
 */
export function DisputeClock(params: AgWidgetParams<DisputeDef>) {
  const { widgetApi, dataMapping } = params;
  const context = params.context as ConsoleContext;
  const field = dataMapping.dispute?.at(0);
  if (!field) return <AgIncompleteDataMappingOverlay />;
  const response = use(widgetApi.getData({ fields: [field] }, { queryId: "disputes" }));
  if (response.replaced) return null;
  const ids = new Set(response.results.rows.map((r) => String(r[field.key])));
  const visible = [...context.disputes.values()].filter((d) => ids.has(d.dispute_id));
  const d = visible[0];
  if (!d) return <AgNoDataOverlay />;
  const outcome = d.outcome ? OUTCOME[d.outcome] : OUTCOME.open;

  return (
    <article
      aria-label={`Dispute ${d.dispute_id}`}
      className="grid h-full content-start gap-4 overflow-auto p-4 text-ui"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <Amount value={Number(d.amount_minor) / 100} currency={d.currency} className="text-2xl" />
        <span className={`inline-flex items-center gap-1.5 font-medium text-xs ${outcome.tone}`}>
          <span aria-hidden="true">{outcome.glyph}</span>
          {d.outcome === "queued" && d.ready_at ? `Queued until ${time(d.ready_at)}` : outcome.text}
        </span>
      </header>
      <p className="text-muted-foreground">
        {visible.length > 1
          ? `Latest of ${visible.length} disputes. Select a row to pick one.`
          : "Selected dispute."}
      </p>
      <p className="font-medium text-3xl tabular-nums tracking-tight">
        {d.elapsed_ms !== null ? duration(d.elapsed_ms) : "Open"}
        <span className="block font-normal text-muted-foreground text-xs tracking-normal">
          {d.elapsed_ms !== null
            ? "from PayPal's dispute to Keelson's signed verdict"
            : "No verdict yet"}
        </span>
      </p>
      <ol className="grid gap-3">
        <Event when={d.received_at}>
          PayPal opened <span className="font-mono">{d.dispute_id}</span> (
          {d.reason.toLowerCase().replaceAll("_", " ")})
        </Event>
        {d.attributed_at ? (
          <Event when={d.attributed_at}>
            Both TEEs signed the verdict:{" "}
            <strong>{d.liable ? LIABLE[d.liable] : "no party"}</strong> liable under rule{" "}
            <span className="font-mono">{d.rule}</span>
          </Event>
        ) : null}
        {d.paid_by ? (
          <Event when={d.settled_at}>
            {PAID_BY[d.paid_by]} {d.outcome === "paid" ? "paid" : "pays"} you
            {d.rail ? `, ${RAIL[d.rail]}` : ""}
          </Event>
        ) : null}
      </ol>
      <nav aria-label="Checks outside Keelson" className="flex flex-wrap gap-x-4 gap-y-1">
        {d.has_alibi ? (
          <a
            className="underline"
            href={`${VERIFY}/a/${d.purchase_id}`}
            target="_blank"
            rel="noopener"
          >
            Verify the Alibi ↗<span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : null}
        {d.explorer_url ? (
          <a className="underline" href={d.explorer_url} target="_blank" rel="noopener">
            Settlement transaction ↗<span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : null}
      </nav>
    </article>
  );
}
