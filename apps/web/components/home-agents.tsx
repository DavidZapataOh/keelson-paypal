"use client";

import { Button } from "@keelson/ui/components/button";
import { Check, ChevronRight, Hand } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { post } from "../lib/api";
import type { PendingApproval } from "../lib/connections";
import { money } from "../lib/format";

/** "Get started 2/3": what is left of the first run, until all of it is done. */
export function GetStarted({
  connected,
  approved,
  bought,
}: {
  connected: boolean;
  approved: boolean;
  bought: boolean;
}) {
  const steps = [
    { label: "Connect an agent", done: connected, href: "/connect/" },
    { label: "Approve a mandate", done: approved, href: "/connect/" },
    { label: "Run a test purchase", done: bought, href: "/agents/" },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  return (
    <section aria-labelledby="get-started" className="rounded-3xl border bg-card p-5 sm:p-6">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="get-started" className="font-semibold text-lg tracking-tight">
          Get started
        </h2>
        <span className="text-muted-foreground text-sm tnum">
          {done}/{steps.length}
        </span>
      </div>
      <ol className="grid gap-1 sm:grid-cols-3 sm:gap-3">
        {steps.map((s) => (
          <li key={s.label}>
            <Link
              href={s.href}
              aria-disabled={s.done}
              className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-foreground/4 aria-disabled:pointer-events-none"
            >
              <span
                className={`grid size-7 shrink-0 place-items-center rounded-full ${s.done ? "bg-graphite text-bone" : "border"}`}
              >
                {s.done ? <Check className="size-3.5" strokeWidth={3} aria-hidden="true" /> : null}
              </span>
              <span className={s.done ? "text-muted-foreground line-through" : "font-medium"}>
                {s.label}
              </span>
              {s.done ? (
                <span className="sr-only">done</span>
              ) : (
                <ChevronRight className="ml-auto size-4 text-muted-foreground" aria-hidden="true" />
              )}
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** A cart an agent tried outside its mandate, paused until the user approves it once or declines. */
export function PausedApprovals({
  approvals,
  onAnswered,
}: {
  approvals: PendingApproval[];
  onAnswered: () => void;
}) {
  const [busy, setBusy] = useState<string>();
  if (approvals.length === 0) return null;
  return (
    <section aria-label="Paused for your approval" className="grid gap-2">
      {approvals.map((a) => {
        const amount = money(a.amountMinor, a.currency);
        return (
          <div
            key={a.code}
            className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-3xl border border-foreground/15 bg-card p-4 sm:p-5"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-bone-2">
              <Hand className="size-5" aria-hidden="true" />
            </span>
            <span className="grid min-w-0 flex-1 leading-snug">
              <span className="font-semibold">
                {a.name} wants {amount}
                {a.overMinor ? `, ${money(a.overMinor, a.currency)} above this mandate` : ""}
              </span>
              <span className="text-muted-foreground text-sm">
                Paused at {a.merchant}
                {a.overMinor ? "" : ", a store this mandate does not allow"}. Nothing is paid until
                you answer.
              </span>
            </span>
            <span className="grid w-full grid-cols-2 gap-2 sm:w-auto">
              <Button
                variant="outline"
                size="lg"
                className="rounded-xl"
                disabled={busy === a.code}
                onClick={async () => {
                  setBusy(a.code);
                  await post(`/v1/connections/${a.code}/deny`).catch(() => undefined);
                  setBusy(undefined);
                  onAnswered();
                }}
              >
                Decline
              </Button>
              <Button asChild size="lg" className="rounded-xl">
                <Link href={`/connect/?c=${a.code}`}>Approve once</Link>
              </Button>
            </span>
          </div>
        );
      })}
    </section>
  );
}
