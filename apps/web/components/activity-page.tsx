"use client";

import { Skeleton } from "@keelson/ui/components/skeleton";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useState } from "react";
import { get } from "../lib/api";
import { authClient } from "../lib/auth";
import type { AgentRow } from "../lib/connections";
import { useEvents, userChannel } from "../lib/events";
import { AppShell } from "./app-shell";
import { ErrorNotice } from "./notice";
import { PageHead } from "./page-head";
import { Mark } from "./surface";

/** One plain line of what an agent or Keelson did, as `GET /v1/activity` answers it. */
interface ActivityRow {
  id: string;
  at: string;
  tone: "good" | "warn" | "bad";
  line: string;
  agentId: string | null;
  purchaseId: string | null;
  href: string | null;
  alibiUrl: string | null;
  logIndex: string | null;
}

const MARK = { good: "bought", warn: "attention", bad: "blocked" } as const;
const TONE = { good: "Done", warn: "Needs you", bad: "Stopped" } as const;

const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const dayOf = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(d);
};

function Row({ row }: { row: ActivityRow }) {
  return (
    <li className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5 py-4 sm:grid-cols-[auto_1fr_auto] sm:items-center">
      <span className="row-span-2 sm:row-span-1">
        <Mark kind={MARK[row.tone]} />
        <span className="sr-only">{TONE[row.tone]}: </span>
      </span>
      <span className="grid min-w-0 gap-0.5">
        {row.href ? (
          <Link
            href={row.href}
            className="text-pretty leading-snug underline-offset-4 hover:underline"
          >
            {row.line}
          </Link>
        ) : (
          <span className="text-pretty leading-snug">{row.line}</span>
        )}
        <time dateTime={row.at} className="text-muted-foreground text-sm tnum">
          {time.format(new Date(row.at))}
        </time>
      </span>
      {row.alibiUrl || row.logIndex ? (
        <span className="col-start-2 flex flex-wrap items-center gap-2 sm:col-start-3 sm:justify-end">
          {row.logIndex ? (
            <span className="rounded-md bg-bone-2 px-2 py-1 font-mono text-xs tnum">
              Log #{row.logIndex}
            </span>
          ) : null}
          {row.alibiUrl ? (
            <a
              href={row.alibiUrl}
              target="_blank"
              rel="noopener"
              className="inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 font-medium text-sm hover:bg-foreground/5"
            >
              Alibi
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
              <span className="sr-only">(opens the public verifier)</span>
            </a>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

/** `/activity/`: what your agents and Keelson did, one plain line each, with the proof. */
export function ActivityPage() {
  const session = authClient.useSession();
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [agent, setAgent] = useState("");
  const [rows, setRows] = useState<ActivityRow[]>();
  const [error, setError] = useState<string>();
  const id = useId();

  const load = useCallback(() => {
    get<{ rows: ActivityRow[] }>(`/v1/activity${agent ? `?agent=${agent}` : ""}`).then(
      (r) => setRows(r.rows),
      (e: Error) => setError(e.message),
    );
  }, [agent]);
  useEffect(load, [load]);
  useEffect(() => {
    get<{ agents: AgentRow[] }>("/v1/agents").then(
      (r) => setAgents(r.agents),
      () => setAgents([]),
    );
  }, []);
  useEvents(session.data ? userChannel(session.data.user.id, "agents") : undefined, load, load);

  const days: [string, ActivityRow[]][] = [];
  for (const r of rows ?? []) {
    const d = dayOf(r.at);
    const last = days.at(-1);
    if (last?.[0] === d) last[1].push(r);
    else days.push([d, [r]]);
  }

  return (
    <AppShell>
      <div className="grid max-w-4xl gap-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <PageHead
            title="Activity"
            line="What your agents did and what Keelson stopped, in plain words, with the proof."
          />
          {agents.length > 1 ? (
            <div className="mb-6 grid gap-1">
              <label htmlFor={id} className="text-muted-foreground text-sm">
                Agent
              </label>
              <select
                id={id}
                value={agent}
                onChange={(e) => {
                  setRows(undefined);
                  setAgent(e.target.value);
                }}
                className="h-10 rounded-xl border bg-card px-3 pr-8 text-sm"
              >
                <option value="">All agents</option>
                {agents.map((a) => (
                  <option key={a.agentId} value={a.agentId}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
        {error ? <ErrorNotice>{error}</ErrorNotice> : null}

        {rows === undefined ? (
          <div className="grid gap-3 rounded-3xl border bg-card p-5" aria-hidden="true">
            <Skeleton className="h-12 rounded-xl" />
            <Skeleton className="h-12 rounded-xl" />
            <Skeleton className="h-12 rounded-xl" />
          </div>
        ) : rows.length === 0 ? (
          <section className="grid gap-2 rounded-3xl border bg-card p-6">
            <h2 className="font-semibold text-lg">Nothing yet</h2>
            <p className="text-muted-foreground">
              Requests, purchases, blocked carts and stops show up here as they happen.{" "}
              <Link href="/connect/" className="text-foreground underline underline-offset-4">
                Connect an agent
              </Link>{" "}
              to start.
            </p>
          </section>
        ) : (
          days.map(([day, list]) => (
            <section key={day} aria-label={day} className="rounded-3xl border bg-card px-5 sm:px-6">
              <h2 className="pt-5 font-semibold">{day}</h2>
              <ul className="divide-y">
                {list.map((r) => (
                  <Row key={r.id} row={r} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </AppShell>
  );
}
