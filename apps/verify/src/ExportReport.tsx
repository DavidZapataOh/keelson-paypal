import type { ExportReport as Report } from "@keelson/interop";

const LABELS: Record<string, string> = {
  issuer: "Signed by Keelson's attested enclave",
  signatures: "Its own signatures and bindings hold",
  statement: "The transparency-log statement is the enclaves' countersign",
  receipt: "The log's receipt includes that statement",
  facts: "Every amount, currency and decision matches the statement",
  chain_binding: "Each mandate hop is bound to the one before",
  nonce: "The closed mandates name this purchase",
  receipt_reference: "Each receipt names its closed mandate",
  tag: "The request is tagged for payment",
  window: "The request's time window holds",
};

/** What checking a received standards export found, in the browser. */
export function ExportReport({ name, report }: { name: string; report: Report }) {
  return (
    <section
      aria-labelledby="export-report"
      className={`space-y-3 rounded-[14px] border bg-bone-2 p-6 ${report.ok ? "border-border" : "border-vermilion"}`}
    >
      <h2
        id="export-report"
        className={`font-semibold text-2xl tracking-tight ${report.ok ? "text-ok" : "text-vermilion-deep"}`}
      >
        {report.ok ? "Export verified" : "Export not verified"}
      </h2>
      <p className="text-muted-foreground text-sm">{name}</p>
      <ul className="space-y-1 text-sm">
        {report.checks.map((c) => (
          <li key={c.id} className="flex gap-2">
            <span
              className={`mt-1.5 size-2 shrink-0 rounded-full ${c.ok ? "bg-ok" : "bg-vermilion"}`}
              aria-hidden="true"
            />
            <span>
              {LABELS[c.id] ?? c.id}
              <span className="sr-only">{c.ok ? ": passed" : ": failed"}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-xs">
        Checked in your browser in {Math.round(report.ms)} ms; nothing was sent.
      </p>
    </section>
  );
}
