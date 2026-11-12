"use client";

import { STATUS_URI } from "@keelson/mandate/browser";
import { Button } from "@keelson/ui/components/button";
import { Skeleton } from "@keelson/ui/components/skeleton";
import { Bot, EllipsisVertical, OctagonX, Plus, RadioTower } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { get, post } from "../lib/api";
import { authClient } from "../lib/auth";
import { type AgentRow, CONNECT_PROMPT } from "../lib/connections";
import { useEvents, userChannel } from "../lib/events";
import { money } from "../lib/format";
import { AppShell } from "./app-shell";
import { HoldButton } from "./hold-button";
import { ErrorNotice } from "./notice";
import { PhoneApprovalsOffer } from "./phone-approvals";

const ago = (iso: string) => {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(iso));
};

const short = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(iso));

/** A stop of every agent, as `POST /v1/agents/stop` answers it. */
interface Stop {
  id: string;
  revoked: number;
  /** Single-use cards closed at the issuer. */
  cardsClosed: number;
  released: { currency: string; minor: string }[];
  releasing: { currency: string; minor: string }[];
  logIndexes: Record<string, string>;
  statusListed?: number;
}

/** What the stop did, with the money PayPal releases and where the log records it. */
function Stopped({ stop }: { stop: Stop }) {
  const sum = (m: Stop["released"]) => m.map((r) => money(BigInt(r.minor), r.currency)).join(" + ");
  const index = Object.values(stop.logIndexes)[0];
  return (
    <section
      role="status"
      aria-label="All agents stopped"
      className="grid gap-1.5 rounded-2xl bg-graphite px-4 py-3.5 text-bone"
    >
      <p className="font-semibold">
        All agents stopped.{" "}
        {stop.released.length > 0
          ? `${sum(stop.released)} of holds released.`
          : stop.releasing.length > 0
            ? ""
            : "Nothing was held."}
        {stop.cardsClosed > 0
          ? ` ${stop.cardsClosed} single-use ${stop.cardsClosed === 1 ? "card" : "cards"} closed.`
          : ""}
      </p>
      <p className="text-bone/75 text-sm">
        {stop.revoked} {stop.revoked === 1 ? "mandate" : "mandates"} ended, every request denied and
        every agent's access revoked. Keelson refuses every payment they try.
        {stop.releasing.length > 0
          ? ` ${sum(stop.releasing)} still backs purchases already approved and is released once they settle.`
          : ""}{" "}
        {index
          ? `Recorded in the public log at entry #${index}.`
          : "It is recorded in the public log once those purchases are logged."}
      </p>
      {stop.statusListed ? (
        <a
          href={STATUS_URI}
          target="_blank"
          rel="noopener"
          className="text-bone/75 text-sm underline underline-offset-4 hover:text-bone"
        >
          {stop.statusListed} {stop.statusListed === 1 ? "approval" : "approvals"} revoked in the
          public status list
        </a>
      ) : null}
    </section>
  );
}

const EFFECT =
  "Takes effect immediately. Keelson will refuse every payment from this agent from now on. Purchases already in flight are not affected.";

/** The revoke menu, each choice with what it stops; the destructive ones are held to confirm. */
function RevokeMenu({ agent, onDone }: { agent: AgentRow; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (open) ref.current?.showModal();
    else ref.current?.close();
  }, [open]);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await run();
      setOpen(false);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "It could not be stopped. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="grid size-10 place-items-center rounded-lg text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
        aria-label={`Revoke options for ${agent.name}`}
      >
        <EllipsisVertical className="size-4" aria-hidden="true" />
      </button>
      <dialog
        ref={ref}
        onClose={() => setOpen(false)}
        aria-labelledby={`revoke-${agent.agentId}-${agent.clientId ?? ""}`}
        className="m-auto w-[min(440px,calc(100vw-2rem))] rounded-3xl border bg-card p-0 text-foreground shadow-[0_30px_60px_-30px_rgb(23_24_27/0.55)] backdrop:bg-graphite/40"
      >
        <div className="grid gap-4 p-5 sm:p-6">
          <h2
            id={`revoke-${agent.agentId}-${agent.clientId ?? ""}`}
            className="font-semibold text-lg"
          >
            Stop {agent.name}
          </h2>
          <p className="text-muted-foreground text-sm">{EFFECT}</p>
          <div className="grid gap-2">
            {agent.mandate ? (
              <HoldButton
                hint={`Hold to revoke the ${money(agent.mandate.maxMinor, agent.mandate.currency)} mandate only. ${agent.name} stays connected.`}
                disabled={busy}
                onConfirm={() => act(() => post(`/v1/mandates/${agent.mandate?.id}/revoke`))}
                className="grid h-auto gap-0.5 rounded-xl border px-4 py-3 text-left"
              >
                <span className="font-medium">Revoke this mandate</span>
                <span className="text-muted-foreground text-sm">
                  Ends the {money(agent.mandate.maxMinor, agent.mandate.currency)} mandate. Hold to
                  confirm.
                </span>
              </HoldButton>
            ) : null}
            <HoldButton
              hint={
                agent.clientId
                  ? `Hold to disconnect ${agent.name}: the mandates you approved for it and its access end. Other apps stay connected.`
                  : `Hold to disconnect ${agent.name}: every mandate of yours that names it ends.`
              }
              disabled={busy}
              onConfirm={() =>
                act(() =>
                  post(
                    `/v1/agents/${agent.agentId}/disconnect${agent.clientId ? `?client=${encodeURIComponent(agent.clientId)}` : ""}`,
                  ),
                )
              }
              className="grid h-auto gap-0.5 rounded-xl border px-4 py-3 text-left"
            >
              <span className="font-medium">Disconnect this agent</span>
              <span className="text-muted-foreground text-sm">
                {agent.clientId
                  ? "Ends the mandates you approved for it and signs it out. It must ask again. Hold to confirm."
                  : "Ends every mandate that names it. It must ask again. Hold to confirm."}
              </span>
            </HoldButton>
          </div>
          {error ? <ErrorNotice>{error}</ErrorNotice> : null}
          <Button variant="outline" size="lg" onClick={() => setOpen(false)} className="rounded-xl">
            Keep it
          </Button>
        </div>
      </dialog>
    </>
  );
}

function Row({ agent, onChange }: { agent: AgentRow; onChange: () => void }) {
  const m = agent.mandate;
  const max = m ? Number(m.maxMinor) : 0;
  const left = m ? Number(m.remainingMinor) : 0;
  return (
    <li className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3.5 gap-y-2 py-4">
      <span className="grid size-10 place-items-center rounded-xl bg-bone-2">
        <Bot className="size-5" aria-hidden="true" />
      </span>
      <span className="grid min-w-0 leading-tight">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{agent.name}</span>
          <span
            className={`rounded-full px-2 py-0.5 text-xs ${m ? "bg-graphite text-bone" : "bg-bone-2 text-muted-foreground"}`}
          >
            {m
              ? m.state === "ACTIVE"
                ? "Mandate live"
                : "Waiting for PayPal"
              : agent.connected
                ? "Connected"
                : "Stopped"}
          </span>
          {agent.signals ? (
            <span
              className="flex items-center gap-1 text-muted-foreground text-xs"
              title="This app polls Keelson's Shared Signals stream (OpenID SSF): it learns at once when you stop or disconnect it."
            >
              <RadioTower className="size-3.5" aria-hidden="true" />
              Gets stop signals
            </span>
          ) : null}
        </span>
        <span className="truncate text-muted-foreground text-sm">
          {agent.operator} · last active {ago(agent.lastActivityAt)}
        </span>
      </span>
      {m || agent.connected ? <RevokeMenu agent={agent} onDone={onChange} /> : <span />}
      {m ? (
        <div className="col-span-3 grid gap-1.5 sm:col-span-2 sm:col-start-2">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span>
              <span className="font-medium tnum">{money(m.remainingMinor, m.currency)}</span>
              <span className="text-muted-foreground">
                {" "}
                left of {money(m.maxMinor, m.currency)}
              </span>
            </span>
            <span className="truncate text-muted-foreground">
              {m.merchants.join(", ")} · until {short(m.expiresAt)}
            </span>
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: a native <meter> cannot be drawn as this bar */}
          <div
            role="meter"
            aria-label={`${agent.name} has spent`}
            aria-valuemin={0}
            aria-valuemax={max}
            aria-valuenow={max - left}
            className="h-1.5 overflow-hidden rounded-full bg-foreground/10"
          >
            <div
              className="h-full origin-left rounded-full bg-graphite"
              style={{ transform: `scaleX(${max > 0 ? (max - left) / max : 0})` }}
            />
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** `/agents/`: each agent with its mandate and what is left, and the ways to stop it. */
export function AgentsPage() {
  const session = authClient.useSession();
  const [agents, setAgents] = useState<AgentRow[]>();
  const [error, setError] = useState<string>();
  const [stopped, setStopped] = useState<Stop>();
  const [stopping, setStopping] = useState(false);

  const load = useCallback(() => {
    get<{ agents: AgentRow[] }>("/v1/agents")
      .then((r) => setAgents(r.agents))
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useEvents(session.data ? userChannel(session.data.user.id, "agents") : undefined, load, load);

  const live = agents?.filter((a) => a.mandate || a.connected) ?? [];

  return (
    <AppShell>
      <div className="grid gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid gap-1">
            <h1 className="font-semibold text-[1.75rem] leading-tight tracking-[-0.025em]">
              Agents
            </h1>
            <p className="text-muted-foreground">Who may spend, how much is left, and the stop.</p>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline" size="lg" className="rounded-xl">
              <Link href="/connect/">
                <Plus aria-hidden="true" />
                Connect an agent
              </Link>
            </Button>
            {live.length > 0 ? (
              <HoldButton
                ms={1600}
                disabled={stopping}
                hint="Hold to stop every agent: all your mandates end, PayPal releases what they hold, every agent loses access and Keelson refuses every payment from now on."
                onConfirm={async () => {
                  setStopping(true);
                  setError(undefined);
                  try {
                    setStopped(await post<Stop>("/v1/agents/stop"));
                  } catch (e) {
                    setError(
                      e instanceof Error ? e.message : "It could not be stopped. Try again.",
                    );
                  } finally {
                    setStopping(false);
                    load();
                  }
                }}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-vermilion-deep px-4 font-medium text-bone text-sm"
              >
                <OctagonX className="size-4" aria-hidden="true" />
                {stopping ? "Stopping" : "Hold to stop all agents"}
              </HoldButton>
            ) : null}
          </div>
        </div>
        {stopped ? <Stopped stop={stopped} /> : null}
        {live.length > 0 ? <PhoneApprovalsOffer /> : null}
        {error ? <ErrorNotice>{error}</ErrorNotice> : null}

        <section aria-label="Your agents" className="rounded-3xl border bg-card px-5 sm:px-6">
          {agents === undefined ? (
            <div className="grid gap-3 py-5" aria-hidden="true">
              <Skeleton className="h-12 rounded-xl" />
              <Skeleton className="h-12 rounded-xl" />
            </div>
          ) : agents.length === 0 ? (
            <div className="grid gap-4 py-6">
              <div className="grid gap-1">
                <h2 className="font-semibold text-lg">No agents yet</h2>
                <p className="text-muted-foreground">
                  Paste this into your agent to connect it. It asks; you approve.
                </p>
              </div>
              <pre className="whitespace-pre-wrap rounded-xl bg-graphite px-4 py-3.5 font-mono text-[13px] text-bone leading-relaxed">
                {CONNECT_PROMPT}
              </pre>
            </div>
          ) : (
            <ul className="divide-y">
              {agents.map((a) => (
                <Row key={`${a.agentId}:${a.clientId ?? ""}`} agent={a} onChange={load} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </AppShell>
  );
}
