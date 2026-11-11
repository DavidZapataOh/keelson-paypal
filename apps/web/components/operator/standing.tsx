"use client";

import { addresses } from "@keelson/chain";
import { Amount } from "@keelson/ui/components/amount";
import { DataItem, DataList } from "@keelson/ui/components/data-list";
import { Skeleton } from "@keelson/ui/components/skeleton";
import { ArrowUpRight, Check, Plus, TriangleAlert } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { API } from "../../lib/config";
import { major } from "../../lib/format";
import {
  type Bond,
  bondOf,
  CHAIN_ID,
  EXPLORER,
  gradeOf,
  type TrustGrade,
} from "../../lib/operator";
import { SplitK } from "../brand";
import { CardAmount } from "../mandate-visual";
import { ErrorNotice } from "../notice";
import { Panel } from "../surface";
import { DepositSheet } from "./deposit-sheet";

/** PYUSD has 6 decimals; it trades 1:1 with the US dollar. */
const pyusd = (base: string | bigint) => Number(BigInt(base)) / 1e6;
const pct = (ppm: number) => `${(ppm / 10_000).toFixed(2)} %`;
const plain = (v: number) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);

const GRADES: Record<TrustGrade["grade"], { word: string; ceilingPpm: number }> = {
  A: { word: "Sound", ceilingPpm: 10_000 },
  B: { word: "Good", ceilingPpm: 20_000 },
  C: { word: "Watch", ceilingPpm: 50_000 },
  D: { word: "At risk", ceilingPpm: 100_000 },
  F: { word: "Failing", ceilingPpm: Number.POSITIVE_INFINITY },
};

const VAULT = addresses[CHAIN_ID].KeelsonBondVault;

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** The bond as an object you hold: what backs coverage now, how it splits, and the minimum. */
function BondCard({
  free,
  locked,
  queued,
  minimum,
}: {
  free: number;
  locked: number;
  queued: number;
  minimum: number;
}) {
  return (
    <section
      aria-label="Bond"
      className="relative isolate flex aspect-[1.586/1] w-full flex-col overflow-hidden rounded-[22px] bg-graphite p-[6%] text-bone shadow-[0_30px_60px_-30px_rgb(23_24_27/0.55),0_2px_6px_-2px_rgb(23_24_27/0.3)]"
      style={{ containerType: "inline-size" }}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <SplitK stem="#F2F0EA" className="size-[max(18px,5cqi)]" />
          <span className="font-mono text-[max(10px,2.6cqi)] text-bone/70 uppercase tracking-[0.16em]">
            Bond
          </span>
        </span>
        <span className="rounded-full border border-bone/20 px-2.5 py-0.5 font-mono text-[max(10px,2.4cqi)] text-bone/80 uppercase tracking-[0.12em]">
          PYUSD
        </span>
      </div>
      <div className="mt-auto grid gap-[1.5cqi]">
        <span className="text-[max(12px,3.2cqi)] text-bone/70">Backing coverage</span>
        <span className="text-[max(34px,11cqi)] leading-none">
          <CardAmount value={free + locked} currency="USD" />
        </span>
      </div>
      <ul
        data-testid="bond-ledger"
        className="mt-[4cqi] flex flex-wrap gap-1.5 font-mono text-[max(11px,2.8cqi)] text-bone/85"
      >
        <li className="rounded-md bg-bone/10 px-2 py-0.5">
          Free <span className="tnum">{plain(free)}</span>
        </li>
        <li className="rounded-md bg-bone/10 px-2 py-0.5">
          Locked <span className="tnum">{plain(locked)}</span>
        </li>
        <li className="rounded-md bg-bone/10 px-2 py-0.5">
          Queued <span className="tnum">{plain(queued)}</span>
        </li>
        <li className="rounded-md border border-bone/25 px-2 py-0.5">
          Min <span className="tnum">{plain(minimum)}</span>
        </li>
      </ul>
    </section>
  );
}

function Action({
  label,
  icon,
  primary,
  ...rest
}: { label: string; icon: ReactNode; primary?: boolean } & (
  | { onClick: () => void; href?: never }
  | { href: string; onClick?: never }
)) {
  const circle = `grid size-14 place-items-center rounded-full transition-transform duration-200 group-hover:-translate-y-0.5 group-active:scale-95 ${primary ? "bg-graphite text-bone" : "bg-bone-2 text-foreground"}`;
  return "href" in rest && rest.href ? (
    <a
      href={rest.href}
      target="_blank"
      rel="noopener"
      className="group grid justify-items-center gap-2 text-sm"
    >
      <span className={circle}>{icon}</span>
      {label}
    </a>
  ) : (
    <button
      type="button"
      onClick={rest.onClick}
      className="group grid justify-items-center gap-2 text-sm"
    >
      <span className={circle}>{icon}</span>
      {label}
    </button>
  );
}

function Reason({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3 py-2">
      <span
        className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-md ${ok ? "bg-ok text-bone" : "bg-bone-2 text-warn"}`}
      >
        {ok ? (
          <Check className="size-3.5" strokeWidth={3} aria-hidden="true" />
        ) : (
          <TriangleAlert className="size-3.5" strokeWidth={2.5} aria-hidden="true" />
        )}
      </span>
      <span className="text-pretty">{children}</span>
    </li>
  );
}

/**
 * The operator's standing: its bond as a card (what backs coverage, how it splits, the minimum)
 * with the gasless top-up, and its trust grade with the reasons behind it and the premium it
 * prices. The grade follows the API's event stream.
 */
export function Standing({ agentId, owner }: { agentId: string; owner: `0x${string}` }) {
  const [bond, setBond] = useState<Bond>();
  const [grade, setGrade] = useState<TrustGrade>();
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const [sheet, setSheet] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [b, g] = await Promise.all([bondOf(agentId), gradeOf(agentId)]);
      setBond(b);
      setGrade(g);
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [agentId]);

  useEffect(() => {
    void refresh();
    const stream = new EventSource(`${API}/v1/operators/${agentId}/grade/stream`);
    stream.addEventListener("grade", (e) => setGrade(JSON.parse((e as MessageEvent).data)));
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      stream.close();
      clearInterval(tick);
    };
  }, [agentId, refresh]);

  if (error) return <ErrorNotice>The bond could not be read: {error}</ErrorNotice>;
  if (!bond || !grade) {
    return (
      <div className="grid gap-6 lg:grid-cols-[400px_1fr]">
        <p className="sr-only" role="status">
          Reading the bond on Arbitrum Sepolia…
        </p>
        <Skeleton className="aspect-[1.586/1] rounded-[22px]" />
        <Skeleton className="h-72 rounded-3xl" />
      </div>
    );
  }

  const free = pyusd(bond.bond.free);
  const locked = pyusd(bond.bond.locked);
  const queued = pyusd(bond.bond.queued);
  const minimum = major(grade.bond.requiredMinor, "USD");
  const gap = free + locked - minimum;
  const g = GRADES[grade.grade];
  const { incidents, coverages } = grade.evidence;

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[400px_1fr]">
      <div className="grid gap-5">
        <BondCard free={free} locked={locked} queued={queued} minimum={minimum} />
        <p className="flex items-center gap-2 text-sm" data-testid="bond-minimum">
          {gap >= 0 ? (
            <>
              <Check className="size-4 text-ok" strokeWidth={2.5} aria-hidden="true" />
              <span>
                <Amount value={gap} hideCurrency /> PYUSD above the minimum
              </span>
            </>
          ) : (
            <>
              <TriangleAlert className="size-4 text-warn" aria-hidden="true" />
              <span>
                <span className="font-medium text-warn">Below the minimum</span>: top up{" "}
                <Amount value={-gap} hideCurrency /> PYUSD
              </span>
            </>
          )}
        </p>
        <div className="flex gap-6">
          <Action
            label="Top up"
            primary
            icon={<Plus className="size-6" aria-hidden="true" />}
            onClick={() => setSheet(true)}
          />
          <Action
            label="Vault"
            icon={<ArrowUpRight className="size-5" aria-hidden="true" />}
            href={`${EXPLORER}/address/${VAULT}`}
          />
        </div>
        <p className="text-muted-foreground text-xs">
          No gas: you sign, Keelson sends. Slashed {bond.bond.slashCount}{" "}
          {bond.bond.slashCount === 1 ? "time" : "times"}.
        </p>
      </div>

      <Panel
        title="Trust grade"
        aside={
          <span className="text-muted-foreground text-xs" aria-live="polite">
            Updated {ago(grade.computedAt, now)} · live
          </span>
        }
      >
        <div className="flex items-center gap-4">
          <span
            data-testid="grade"
            className="grid size-16 place-items-center rounded-2xl bg-graphite font-mono font-semibold text-4xl text-bone"
          >
            {grade.grade}
          </span>
          <span className="grid gap-0.5">
            <span className="font-semibold text-lg">{g.word}</span>
            <span className="text-muted-foreground text-sm">
              {Number.isFinite(g.ceilingPpm)
                ? `Holds while incidents stay at or below ${pct(g.ceilingPpm)}`
                : "Below every other grade"}
            </span>
          </span>
        </div>
        <ul className="mt-4 grid divide-y">
          <Reason ok={coverages > 0}>
            <span className="font-mono tnum">{coverages.toLocaleString("en-US")}</span> covered
            purchases
          </Reason>
          <Reason ok={incidents.total === 0}>
            <span className="font-mono tnum">{incidents.total}</span>{" "}
            {incidents.total === 1 ? "incident" : "incidents"} at fault
            {incidents.total > 0
              ? ` · ${incidents.slashes} slashed, ${incidents.pool} from the pool`
              : ""}
          </Reason>
          <Reason ok={grade.frequency.upper95_ppm <= g.ceilingPpm}>
            Incident rate at most{" "}
            <span className="font-mono tnum">{pct(grade.frequency.upper95_ppm)}</span> (95 % bound)
          </Reason>
          <Reason ok>
            <span className="font-mono tnum">{grade.reserve.warranties}</span> of Keelson&apos;s own
            faults, paid by its reserve, not graded
          </Reason>
        </ul>
        <DataList className="mt-4 border-t pt-2">
          <DataItem label="Premium per coverage">
            <span className="font-mono tabular-nums" data-testid="premium">
              {grade.premium.bps} bps
            </span>
          </DataItem>
          <DataItem label="Model · floor">
            <span className="font-mono tabular-nums">
              {grade.premium.modelBps} bps · {grade.premium.floorBps} bps
            </span>
          </DataItem>
          <DataItem label={`Expected loss, next ${grade.loss.horizon}`}>
            <Amount value={major(grade.loss.expectedMinor, "USD")} />
          </DataItem>
          <DataItem label="Loss at 99 %">
            <Amount value={major(grade.loss.var99Minor, "USD")} />
          </DataItem>
        </DataList>
      </Panel>

      <DepositSheet
        open={sheet}
        onOpenChange={setSheet}
        agentId={agentId}
        owner={owner}
        free={free}
        onDeposited={refresh}
      />
    </div>
  );
}
