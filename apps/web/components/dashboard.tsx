"use client";

import { Button } from "@keelson/ui/components/button";
import Link from "next/link";
import { useEffect, useState } from "react";
import { get } from "../lib/api";
import { money, when } from "../lib/format";
import { mandateLabel } from "../lib/status";
import type { MandateSummary } from "../lib/types";
import { ErrorNotice, Eyebrow } from "./notice";

export function Dashboard() {
  const [mandates, setMandates] = useState<MandateSummary[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    get<{ mandates: MandateSummary[] }>("/v1/mandates")
      .then((r) => setMandates(r.mandates))
      .catch((e: Error) => setError(e.message));
  }, []);

  const live = mandates?.filter((m) => m.state === "ACTIVE") ?? [];
  const left = live.reduce((sum, m) => sum + BigInt(m.budget.remainingMinor), 0n);

  return (
    <div className="grid gap-10">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="grid gap-2">
          <Eyebrow>Your mandates</Eyebrow>
          <h1 className="font-semibold text-3xl tracking-[-0.03em] sm:text-4xl">
            {live.length > 0
              ? `${money(left, live[0]?.budget.currency ?? "USD")} your agents may still spend`
              : "Nothing is delegated yet"}
          </h1>
        </div>
        <Button asChild size="lg">
          <Link href="/new/">New mandate</Link>
        </Button>
      </div>
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
      {mandates && mandates.length === 0 ? (
        <div className="grid max-w-xl gap-3 rounded-xl border border-dashed p-8">
          <h2 className="font-semibold text-xl">Write your first mandate</h2>
          <p className="text-muted-foreground">
            Say what your agent may buy, for how much and by when, for example: “Running shoes, size
            10, under $100, from RunFast, by Friday.” You'll see who answers for each field before
            you sign.
          </p>
        </div>
      ) : null}
      {mandates && mandates.length > 0 ? (
        <ul className="grid divide-y rounded-xl border">
          {mandates.map((m) => (
            <li key={m.id}>
              <Link
                href={`/mandate/?id=${m.id}`}
                className="grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-1 px-5 py-4 hover:bg-accent/60"
              >
                <span className="font-medium">{m.merchantIds.join(", ")}</span>
                <span className="tnum text-right font-mono">
                  {money(m.budget.remainingMinor, m.budget.currency)}
                  <span className="text-muted-foreground">
                    {" "}
                    / {money(m.budget.maxMinor, m.budget.currency)}
                  </span>
                </span>
                <span className="text-muted-foreground text-sm">
                  {mandateLabel(m.state)} · until {when(m.expiresAt)}
                </span>
                <span className="text-right font-mono text-muted-foreground text-xs">
                  {m.id.slice(-8)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
