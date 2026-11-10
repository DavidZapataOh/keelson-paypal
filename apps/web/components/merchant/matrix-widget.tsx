import type { AgWidgetFieldReference, AgWidgetParams } from "ag-studio";
import { AgIncompleteDataMappingOverlay, AgNoDataOverlay } from "ag-studio-react";
import { use } from "react";

export interface MatrixDef {
  type: "field-attribution-matrix";
  format?: { title?: { enabled?: boolean; text?: string } };
  dataMapping: {
    row: AgWidgetFieldReference[];
    column: AgWidgetFieldReference[];
    value: AgWidgetFieldReference[];
  };
}

type Value = string | number | null;

/** Ink at a share of the cell's maximum; the scale is single-hue so the number carries the read. */
function shade(value: number, max: number): string {
  if (value <= 0 || max <= 0) return "transparent";
  const share = 0.08 + 0.62 * (value / max);
  return `color-mix(in oklab, var(--foreground) ${Math.round(share * 100)}%, transparent)`;
}

/**
 * A heatmap of a measure over two dimensions (mandate field × agent): the number in every cell, a
 * dash for zero, and every cell, row and column header a cross-filter on the page.
 */
export function FieldAttributionMatrix(params: AgWidgetParams<MatrixDef>) {
  const { widgetApi, dataMapping } = params;
  const row = dataMapping.row?.at(0);
  const column = dataMapping.column?.at(0);
  const value = dataMapping.value?.at(0);
  if (!row || !column || !value) return <AgIncompleteDataMappingOverlay />;

  const response = use(
    widgetApi.getData({ fields: [row, column, value] }, { queryId: "matrix", crossFilter: "none" }),
  );
  if (response.replaced) return null;
  const data = response.results.rows as Record<string, Value>[];
  if (data.length === 0) return <AgNoDataOverlay />;

  const cells = new Map<string, number>();
  const rowTotals = new Map<Value, number>();
  const columnTotals = new Map<Value, number>();
  for (const r of data) {
    const v = Number(r[value.key] ?? 0);
    cells.set(`${r[row.key]}\u0000${r[column.key]}`, v);
    rowTotals.set(r[row.key] ?? null, (rowTotals.get(r[row.key] ?? null) ?? 0) + v);
    columnTotals.set(r[column.key] ?? null, (columnTotals.get(r[column.key] ?? null) ?? 0) + v);
  }
  // Worst first, both ways: the question is always "where does it fail most".
  const rows = [...rowTotals.keys()].sort(
    (a, b) => (rowTotals.get(b) ?? 0) - (rowTotals.get(a) ?? 0),
  );
  const columns = [...columnTotals.keys()].sort(
    (a, b) => (columnTotals.get(b) ?? 0) - (columnTotals.get(a) ?? 0),
  );
  const max = Math.max(0, ...cells.values());

  const selected = new Set(
    (widgetApi.getCrossFilterSelections() ?? []).flatMap((s) =>
      s.type === "value"
        ? s.values.map((v) => `${s.field.key}=${v}`)
        : s.type === "multiValue"
          ? s.values.map((tuple) => tuple.map((t) => `${t.field.key}=${t.value}`).join("&"))
          : [],
    ),
  );
  const fmt = (v: number) => widgetApi.formatFieldValue(value, v);
  const label = (f: typeof row, v: Value) => widgetApi.formatFieldValue(f, v);
  const additive = (e: React.MouseEvent) => e.metaKey || e.ctrlKey;
  /** A second click on the only selection clears it; with Cmd or Ctrl it adds to the others. */
  const toggle = (key: string, e: React.MouseEvent, select: () => void) => {
    if (selected.has(key) && selected.size === 1 && !additive(e)) widgetApi.resetCrossFilter();
    else select();
  };

  return (
    <div className="keelson-matrix h-full overflow-auto p-3">
      <table className="w-full border-collapse text-ui">
        <caption className="sr-only">
          {`${widgetApi.formatFieldValue(value, max)} is the largest cell. Select a cell, a row or a column to filter the page.`}
        </caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky top-0 left-0 z-20 bg-card p-2 text-left font-medium text-muted-foreground"
            >
              <span className="sr-only">Field by agent</span>
            </th>
            {columns.map((c) => (
              <th
                key={String(c)}
                scope="col"
                className="sticky top-0 z-10 bg-card p-1 align-bottom"
              >
                <button
                  type="button"
                  aria-pressed={selected.has(`${column.key}=${c}`)}
                  className="w-full rounded-sm px-2 py-1 text-left font-medium text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:bg-foreground aria-pressed:text-background"
                  onClick={(e) =>
                    toggle(`${column.key}=${c}`, e, () =>
                      widgetApi.toggleCrossFilter({
                        type: "value",
                        field: column,
                        value: c,
                        group: 0,
                        reset: !additive(e),
                      }),
                    )
                  }
                >
                  {label(column, c)}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r)} className="border-border border-t">
              <th scope="row" className="sticky left-0 z-10 bg-card p-1 text-left">
                <button
                  type="button"
                  aria-pressed={selected.has(`${row.key}=${r}`)}
                  className="w-full whitespace-nowrap rounded-sm px-2 py-1 text-left font-medium hover:bg-accent aria-pressed:bg-foreground aria-pressed:text-background"
                  onClick={(e) =>
                    toggle(`${row.key}=${r}`, e, () =>
                      widgetApi.toggleCrossFilter({
                        type: "value",
                        field: row,
                        value: r,
                        group: 0,
                        reset: !additive(e),
                      }),
                    )
                  }
                >
                  {label(row, r)}
                </button>
              </th>
              {columns.map((c) => {
                const v = cells.get(`${r}\u0000${c}`) ?? 0;
                const key = `${row.key}=${r}&${column.key}=${c}`;
                const strong = max > 0 && v / max > 0.55;
                return (
                  <td key={String(c)} className="p-0.5">
                    <button
                      type="button"
                      aria-pressed={selected.has(key)}
                      aria-label={`${label(row, r)}, ${label(column, c)}: ${v === 0 ? "none" : fmt(v)}`}
                      style={{ backgroundColor: shade(v, max) }}
                      className={`h-9 w-full rounded-sm px-2 text-right font-mono tabular-nums outline-offset-[-2px] aria-pressed:outline aria-pressed:outline-2 aria-pressed:outline-vermilion ${strong ? "text-background" : "text-foreground"}`}
                      onClick={(e) =>
                        toggle(key, e, () =>
                          widgetApi.toggleCrossFilter({
                            type: "multiValue",
                            values: [
                              { field: row, value: r },
                              { field: column, value: c },
                            ],
                            group: 0,
                            reset: !additive(e),
                          }),
                        )
                      }
                    >
                      {v === 0 ? "–" : fmt(v)}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
