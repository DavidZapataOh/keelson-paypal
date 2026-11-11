"use client";

import { Skeleton } from "@keelson/ui/components/skeleton";
import { ChevronRight, Scale } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { get } from "../lib/api";
import { money, when } from "../lib/format";
import type { MandateSummary, MandateView, Purchase } from "../lib/types";
import { AppShell } from "./app-shell";
import { ErrorNotice } from "./notice";

type Row = { mandateId: string; purchase: Purchase; dispute: Purchase["disputes"][number] };

const STATE = { OPEN: "Open", ATTRIBUTED: "Fault named", RESOLVED: "Resolved" } as const;

/** Every dispute over the buyer's purchases, open ones first. */
export function Disputes() {
  const [rows, setRows] = useState<Row[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    get<{ mandates: MandateSummary[] }>("/v1/mandates")
      .then((r) => Promise.all(r.mandates.map((m) => get<MandateView>(`/v1/mandates/${m.id}`))))
      .then((views) =>
        setRows(
          views
            .flatMap((v) =>
              v.purchases.flatMap((p) =>
                p.disputes.map((dispute) => ({ mandateId: v.id, purchase: p, dispute })),
              ),
            )
            .sort(
              (a, b) => Number(b.dispute.state === "OPEN") - Number(a.dispute.state === "OPEN"),
            ),
        ),
      )
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <AppShell>
      <h1 className="mb-6 font-semibold text-[1.75rem] tracking-[-0.025em]">Disputes</h1>
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
      {rows === undefined && !error ? <Skeleton className="h-40 rounded-3xl" /> : null}
      {rows?.length === 0 ? (
        <div className="grid justify-items-center gap-3 rounded-3xl border border-dashed px-6 py-14 text-center">
          <span className="grid size-14 place-items-center rounded-2xl bg-bone-2">
            <Scale className="size-6" aria-hidden="true" />
          </span>
          <p className="font-semibold">No disputes</p>
          <p className="max-w-sm text-muted-foreground text-sm">
            If an order is not what you asked for, open it and tap "Not what you asked for?".
          </p>
        </div>
      ) : null}
      {rows && rows.length > 0 ? (
        <ul className="grid gap-1 rounded-3xl border bg-card p-3">
          {rows.map(({ mandateId, purchase, dispute }) => (
            <li key={dispute.id}>
              <Link
                href={`/purchase/?mandate=${mandateId}&id=${purchase.id}`}
                className="flex items-center gap-4 rounded-2xl px-3 py-3 transition-colors hover:bg-foreground/4"
              >
                <span
                  className={`size-2.5 shrink-0 rounded-full ${dispute.state === "OPEN" ? "animate-pending bg-foreground" : "bg-ok"}`}
                />
                <span className="grid min-w-0 flex-1 leading-tight">
                  <span className="truncate font-medium">{STATE[dispute.state]}</span>
                  <span className="truncate text-muted-foreground text-sm">
                    {dispute.id} · {when(purchase.createdAt)}
                  </span>
                </span>
                <span className="font-mono text-[15px] tnum">
                  {money(purchase.amount.minor, purchase.amount.currency)}
                </span>
                <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </AppShell>
  );
}
