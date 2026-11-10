"use client";

import { Button } from "@keelson/ui/components/button";
import { keelsonChartPalette, keelsonGridTheme } from "@keelson/ui/grid";
import { AgChartsEnterpriseModule } from "ag-charts-enterprise";
import {
  ClientSideRowModelModule,
  type ColDef,
  DateFilterModule,
  type GridApi,
  type GridReadyEvent,
  GridStateModule,
  type IDetailCellRendererParams,
  type IServerSideDatasource,
  NumberFilterModule,
  TextFilterModule,
  ValidationModule,
} from "ag-grid-community";
import {
  AiToolkitModule,
  CellSelectionModule,
  ColumnMenuModule,
  ContextMenuModule,
  IntegratedChartsModule,
  MasterDetailModule,
  ServerSideRowModelModule,
  SetFilterModule,
} from "ag-grid-enterprise";
import { AgGridProvider, AgGridReact } from "ag-grid-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../lib/api";
import { VERIFY } from "../../lib/config";
import {
  type CoverageDay,
  type CoverageRow,
  coverageBlock,
  dailyOf,
  EXPLORER,
  type GridAnswer,
  gridQuery,
} from "../../lib/operator";

const modules = [
  ClientSideRowModelModule,
  ServerSideRowModelModule,
  MasterDetailModule,
  GridStateModule,
  TextFilterModule,
  NumberFilterModule,
  DateFilterModule,
  SetFilterModule,
  ColumnMenuModule,
  ContextMenuModule,
  CellSelectionModule,
  AiToolkitModule,
  IntegratedChartsModule.with(AgChartsEnterpriseModule),
  ...(process.env.NODE_ENV === "production" ? [] : [ValidationModule]),
];

const usd = (v: number | null | undefined) =>
  v == null ? "" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v);
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace("T", " ") : "");

const COVERED_STATES = [
  "COVERED",
  "CAPTURED",
  "DELIVERED",
  "SETTLED",
  "DISPUTED",
  "ATTRIBUTED",
  "SLASHED",
  "WARRANTY_PAID",
  "DEFENDED",
  "MERCHANT_LIABLE",
];

function Link({ href, children }: { href: string | null | undefined; children: string }) {
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  ) : null;
}

/** One coverage's history: covered, disputed, the signed verdict, its settlement. */
interface Event {
  at: string | null;
  actor: string;
  event: string;
  proof: string | null;
  proofLabel: string;
}

function eventsOf(r: CoverageRow): Event[] {
  const out: Event[] = [
    {
      at: r.createdAt,
      actor: "Keelson",
      event: `Locked ${usd(r.amount)} of your bond as coverage; premium ${r.premiumBps ?? 0} bps (${usd(r.premium)})`,
      proof: r.coverageTx,
      proofLabel: "Arbiscan",
    },
  ];
  if (r.disputeId) {
    out.push({
      at: r.disputedAt,
      actor: "Merchant's buyer",
      event: `Opened PayPal dispute ${r.disputeId}: ${r.disputeReason ?? ""}`,
      proof: `${VERIFY}/a/${r.id}`,
      proofLabel: "Alibi",
    });
  }
  if (r.liable) {
    out.push({
      at: r.verdictAt,
      actor: "TEE verdict (2-of-2)",
      event: `Found the ${r.liable} liable under ${r.rule}${r.verdictAmount != null ? ` for ${usd(r.verdictAmount)}` : ""}`,
      proof: null,
      proofLabel: "",
    });
  }
  if (r.outcome) {
    const payer =
      r.paidBy === "chain"
        ? r.liable === "operator"
          ? "your bond (slash)"
          : "Keelson's reserve"
        : r.paidBy === "violation-pool"
          ? "your ViolationBondPool deposit"
          : "Keelson's treasury";
    out.push({
      at: r.settledAt,
      actor: "Keelson relayer",
      event: `Settlement ${r.outcome}, paid by ${payer}`,
      proof: r.settlementTx,
      proofLabel: "Arbiscan",
    });
  }
  return out;
}

/** Summary per day: a client-side grid and, from it, an integrated chart (its table twin). */
function Daily({ agentId }: { agentId: string }) {
  const [days, setDays] = useState<CoverageDay[]>();
  const [error, setError] = useState<string>();
  const chartRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dailyOf(agentId)
      .then(setDays)
      .catch((err: Error) => setError(err.message));
  }, [agentId]);
  const columnDefs = useMemo<ColDef<CoverageDay>[]>(
    () => [
      {
        field: "day",
        headerName: "Day (UTC)",
        chartDataType: "category",
        sort: "asc",
        minWidth: 120,
      },
      {
        field: "coverages",
        headerName: "Coverages",
        type: "rightAligned",
        chartDataType: "series",
      },
      {
        field: "covered",
        headerName: "Covered",
        type: "rightAligned",
        valueFormatter: (p) => usd(p.value),
        chartDataType: "series",
      },
      {
        field: "premiums",
        headerName: "Premiums",
        type: "rightAligned",
        valueFormatter: (p) => usd(p.value),
        chartDataType: "series",
      },
      {
        field: "incidents",
        headerName: "Incidents",
        type: "rightAligned",
        chartDataType: "series",
      },
    ],
    [],
  );
  const dark =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const onFirstDataRendered = useCallback((e: { api: GridApi<CoverageDay> }) => {
    if (!chartRef.current) return;
    e.api.createRangeChart({
      chartContainer: chartRef.current,
      cellRange: { columns: ["day", "covered", "premiums"] },
      // Premiums are about 1 % of the amount covered: a line on their own axis.
      chartType: "customCombo",
      seriesChartTypes: [
        { colId: "covered", chartType: "groupedColumn", secondaryAxis: false },
        { colId: "premiums", chartType: "line", secondaryAxis: true },
      ],
      chartThemeName: "keelson",
      suppressChartRanges: true,
    });
  }, []);
  if (error)
    return <p className="text-destructive text-sm">The daily totals could not be read: {error}</p>;
  return (
    <section aria-labelledby="daily" className="grid gap-3">
      <h2 id="daily" className="font-semibold">
        Coverage per day
      </h2>
      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <figure className="grid gap-1">
          <div ref={chartRef} className="h-72 rounded-[10px] border" />
          <figcaption className="text-muted-foreground text-xs">
            Covered amount and premiums per day, charted from the table beside it.
          </figcaption>
        </figure>
        <div className="h-72">
          <AgGridReact<CoverageDay>
            theme={keelsonGridTheme}
            rowData={days ?? null}
            columnDefs={columnDefs}
            defaultColDef={{ flex: 1, minWidth: 96, suppressHeaderMenuButton: true }}
            enableCharts
            cellSelection
            customChartThemes={{
              keelson: {
                baseTheme: dark ? "ag-default-dark" : "ag-default",
                palette: keelsonChartPalette(dark ? "dark" : "light"),
                overrides: { common: { background: { visible: false } } },
              },
            }}
            chartThemes={["keelson"]}
            onFirstDataRendered={onFirstDataRendered}
            loading={days === undefined}
          />
        </div>
      </div>
    </section>
  );
}

/** A set filter over a column's known values: the server-side row model cannot list them. */
const set = (values: readonly string[]) => ({
  filter: "agSetColumnFilter",
  filterParams: { values: [...values] },
});

/** What the model may change, and how it should read each column. */
const SCHEMA_OPTIONS = {
  exclude: ["aggregation", "pivot", "rowGroup", "columnSizing"],
  columns: {
    amount: { description: "The purchase amount, in US dollars." },
    premium: { description: "The premium Keelson charged on the coverage, in US dollars." },
    premiumBps: { description: "The premium in basis points of the amount." },
    state: { description: "The purchase's lifecycle state.", includeSetValues: true },
    disputeState: {
      description: "The PayPal dispute's state; blank if never disputed.",
      includeSetValues: true,
    },
    liable: {
      description: "Who the signed verdict found liable. 'operator' rows are slashes.",
      includeSetValues: true,
    },
    outcome: { description: "What happened to the verdict's payment.", includeSetValues: true },
    paidBy: { description: "Who paid the verdict.", includeSetValues: true },
    createdAt: { description: "When the purchase was made (UTC)." },
    merchantId: { description: "The store's Keelson id, e.g. mrc_runfast." },
  },
} as const;

/** The coverage book: AG Grid's server-side row model, verdict history per row, NL queries. */
function Book({ agentId }: { agentId: string }) {
  const [api, setApi] = useState<GridApi<CoverageRow>>();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<GridAnswer>();
  const [error, setError] = useState<string>();
  const [total, setTotal] = useState<number>();

  const datasource = useMemo<IServerSideDatasource<CoverageRow>>(
    () => ({
      getRows: (params) => {
        const { startRow, endRow, sortModel, filterModel } = params.request;
        coverageBlock(agentId, { startRow, endRow, sortModel, filterModel })
          .then((r) => {
            setTotal(r.rowCount);
            params.success({ rowData: r.rows, rowCount: r.rowCount });
          })
          .catch(() => params.fail());
      },
    }),
    [agentId],
  );

  const columnDefs = useMemo<ColDef<CoverageRow>[]>(
    () => [
      {
        field: "createdAt",
        headerName: "Covered at (UTC)",
        cellRenderer: "agGroupCellRenderer",
        valueFormatter: (p) => day(p.value),
        filter: "agDateColumnFilter",
        minWidth: 190,
      },
      { field: "merchantId", headerName: "Store", filter: "agTextColumnFilter" },
      {
        field: "amount",
        headerName: "Amount",
        type: "rightAligned",
        valueFormatter: (p) => usd(p.value),
        filter: "agNumberColumnFilter",
      },
      {
        field: "premiumBps",
        headerName: "Premium bps",
        type: "rightAligned",
        filter: "agNumberColumnFilter",
      },
      {
        field: "premium",
        headerName: "Premium",
        type: "rightAligned",
        valueFormatter: (p) => usd(p.value),
        filter: "agNumberColumnFilter",
      },
      { field: "state", headerName: "State", ...set(COVERED_STATES) },
      { field: "disputeState", headerName: "Dispute", ...set(["OPEN", "ATTRIBUTED", "RESOLVED"]) },
      {
        field: "liable",
        headerName: "Liable",
        ...set(["operator", "keelson", "merchant", "user"]),
        cellRenderer: (p: { value: CoverageRow["liable"] }) =>
          p.value === "operator" ? (
            <span>
              <span aria-hidden="true">■ </span>operator · slash
            </span>
          ) : (
            (p.value ?? "")
          ),
      },
      {
        field: "outcome",
        headerName: "Outcome",
        ...set(["paid", "queued", "claimable", "failed"]),
      },
      { field: "paidBy", headerName: "Paid by", ...set(["chain", "treasury", "violation-pool"]) },
      {
        field: "id",
        headerName: "Purchase",
        filter: "agTextColumnFilter",
        cellRenderer: (p: { value: string }) => (
          <Link href={`${VERIFY}/a/${p.value}`}>{p.value}</Link>
        ),
        minWidth: 260,
      },
    ],
    [],
  );

  const detailCellRendererParams = useMemo(
    () =>
      ({
        detailGridOptions: {
          theme: keelsonGridTheme,
          columnDefs: [
            {
              field: "at",
              headerName: "When (UTC)",
              valueFormatter: (p) => day(p.value),
              width: 170,
            },
            { field: "actor", headerName: "Who", width: 190 },
            {
              field: "event",
              headerName: "What",
              flex: 1,
              wrapText: true,
              autoHeight: true,
              cellStyle: { lineHeight: "1.4", paddingBlock: "8px" },
            },
            {
              field: "proof",
              headerName: "Check",
              width: 110,
              cellRenderer: (p: { value: string | null; data: Event }) => (
                <Link href={p.value}>{p.data.proofLabel}</Link>
              ),
            },
          ] satisfies ColDef<Event>[],
          defaultColDef: { sortable: false, suppressHeaderMenuButton: true },
        },
        getDetailRowData: (p) => p.successCallback(eventsOf(p.data)),
      }) satisfies Partial<IDetailCellRendererParams<CoverageRow, Event>>,
    [],
  );

  async function ask(e: FormEvent) {
    e.preventDefault();
    if (!api || prompt.trim() === "") return;
    setBusy(true);
    setError(undefined);
    try {
      const a = await gridQuery(agentId, {
        prompt,
        gridState: api.getState(),
        schema: api.getStructuredSchema(SCHEMA_OPTIONS as never),
      });
      api.setState(a.gridState as never, a.propertiesToIgnore as never);
      setAnswer(a);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? "Today's query budget is spent; filter by hand or try after 00:00 UTC."
          : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    api?.setFilterModel(null);
    api?.applyColumnState({ defaultState: { sort: null } });
    setAnswer(undefined);
    setPrompt("");
  }

  return (
    <section aria-labelledby="book" className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="book" className="font-semibold">
          Coverage book
        </h2>
        <span className="text-muted-foreground text-sm" aria-live="polite">
          {total === undefined ? "" : `${total.toLocaleString("en-US")} coverages`}
        </span>
      </div>
      <form onSubmit={ask} className="flex flex-wrap items-center gap-2">
        <label htmlFor="grid-query" className="sr-only">
          Ask the coverage book
        </label>
        <input
          id="grid-query"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. slashes over $20 at mrc_runfast, largest first"
          maxLength={500}
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
        />
        <Button size="sm" type="submit" disabled={busy || !api}>
          {busy ? "Reading…" : "Ask"}
        </Button>
        <Button size="sm" variant="outline" type="button" onClick={reset}>
          Reset
        </Button>
      </form>
      <p className="min-h-5 text-sm" role="status" data-testid="grid-answer">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : answer ? (
          <>
            {answer.explanation}{" "}
            <span className="text-muted-foreground">
              · {answer.model} · ${(answer.costMicros / 1e6).toFixed(4)} · the filters are in the
              column menus
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">
            A sentence becomes the grid's own filters and sort, which you can change by hand.
          </span>
        )}
      </p>
      <div className="h-[560px]" data-testid="coverage-grid">
        <AgGridReact<CoverageRow>
          theme={keelsonGridTheme}
          rowModelType="serverSide"
          serverSideDatasource={datasource}
          cacheBlockSize={100}
          maxBlocksInCache={20}
          columnDefs={columnDefs}
          defaultColDef={{ flex: 1, minWidth: 120, sortable: true }}
          masterDetail
          detailRowAutoHeight
          detailCellRendererParams={detailCellRendererParams}
          getRowId={(p) => p.data.id}
          onGridReady={(e: GridReadyEvent<CoverageRow>) => setApi(e.api)}
        />
      </div>
      <p className="text-muted-foreground text-xs">
        Settlement and coverage transactions open on <Link href={EXPLORER}>Arbiscan</Link>; each
        purchase opens its Alibi in the public verifier.
      </p>
    </section>
  );
}

export default function CoverageBook({ agentId }: { agentId: string }) {
  return (
    <AgGridProvider modules={modules}>
      <div className="grid gap-10">
        <Daily agentId={agentId} />
        <Book agentId={agentId} />
      </div>
    </AgGridProvider>
  );
}
