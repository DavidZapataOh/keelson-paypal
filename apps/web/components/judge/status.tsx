"use client";

import { useEffect, useState } from "react";
import { type StatusReport, statusReport } from "../../lib/judge";
import { ErrorNotice } from "../notice";
import { HealthList } from "./environment";

const EVERY_MS = 30_000;

/** The live dependency report, refreshed every 30 seconds. */
export function StatusPage() {
  const [report, setReport] = useState<StatusReport>();
  const [checked, setChecked] = useState<Date>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const read = () =>
      statusReport().then(
        (r) => {
          setReport(r);
          setChecked(new Date());
          setError(undefined);
        },
        (e: Error) => setError(`The API did not answer: ${e.message}`),
      );
    void read();
    const timer = setInterval(read, EVERY_MS);
    return () => clearInterval(timer);
  }, []);
  return (
    <section aria-labelledby="health-title" aria-live="polite" className="grid gap-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-2">
        <h2 id="health-title" className="font-semibold text-xl tracking-tight">
          {report
            ? report.status === "ok"
              ? "All systems operational"
              : "Some systems are degraded"
            : "Checking…"}
        </h2>
        <span className="min-h-4 font-mono text-muted-foreground text-xs">
          {checked ? `Checked ${checked.toLocaleTimeString("en-US")}` : null}
        </span>
      </div>
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
      {error && !report ? null : <HealthList report={report} />}
    </section>
  );
}
