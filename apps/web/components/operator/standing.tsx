"use client";

import { Amount } from "@keelson/ui/components/amount";
import { Button } from "@keelson/ui/components/button";
import { DataItem, DataList } from "@keelson/ui/components/data-list";
import { useCallback, useEffect, useState } from "react";
import { API } from "../../lib/config";
import { major } from "../../lib/format";
import { type Bond, bondOf, gradeOf, type TrustGrade } from "../../lib/operator";
import { DepositSheet } from "./deposit-sheet";

/** PYUSD has 6 decimals; it trades 1:1 with the US dollar. */
const pyusd = (base: string | bigint) => Number(BigInt(base)) / 1e6;
const pct = (ppm: number) => `${(ppm / 10_000).toFixed(2)} %`;

const GRADES: Record<TrustGrade["grade"], { word: string; ceilingPpm: number }> = {
  A: { word: "Sound", ceilingPpm: 10_000 },
  B: { word: "Good", ceilingPpm: 20_000 },
  C: { word: "Watch", ceilingPpm: 50_000 },
  D: { word: "At risk", ceilingPpm: 100_000 },
  F: { word: "Failing", ceilingPpm: Number.POSITIVE_INFINITY },
};

function Usd({ value, className }: { value: number; className?: string }) {
  return (
    <span className={className}>
      <Amount value={value} hideCurrency />{" "}
      <span className="text-[0.75em] text-muted-foreground">PYUSD</span>
    </span>
  );
}

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/**
 * The operator's standing: its bond as a ledger (free, locked, queued, and the minimum), its trust
 * grade with the evidence behind it, and the premium each coverage pays. The grade follows the
 * API's event stream.
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

  if (error) {
    return (
      <p role="alert" className="text-destructive text-sm">
        The bond could not be read: {error}
      </p>
    );
  }
  if (!bond || !grade) {
    return <p className="text-muted-foreground text-sm">Reading the bond on Arbitrum Sepolia…</p>;
  }

  const free = pyusd(bond.bond.free);
  const locked = pyusd(bond.bond.locked);
  const queued = pyusd(bond.bond.queued);
  const total = free + locked + queued;
  const minimum = major(grade.bond.requiredMinor, "USD");
  const backing = free + locked;
  const gap = backing - minimum;
  const g = GRADES[grade.grade];
  const incidents = grade.evidence.incidents.total;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section aria-labelledby="bond" className="rounded-[10px] border p-5">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="bond" className="font-semibold">
            Bond
          </h2>
          <span className="text-muted-foreground text-xs">KeelsonBondVault · Arbitrum Sepolia</span>
        </div>
        <DataList className="mt-3" data-testid="bond-ledger">
          <DataItem label="Free: backs new coverage, withdrawable">
            <Usd value={free} />
          </DataItem>
          <DataItem label="Locked: backing open coverages until their dispute window ends">
            <Usd value={locked} />
          </DataItem>
          <DataItem label="Queued: being withdrawn, still slashable">
            <Usd value={queued} />
          </DataItem>
          <DataItem label={<span className="font-medium text-foreground">Total</span>}>
            <Usd value={total} className="font-medium" />
          </DataItem>
        </DataList>
        <p className="mt-4 text-sm" data-testid="bond-minimum">
          {gap >= 0 ? (
            <>
              <span aria-hidden="true">■ </span>
              Free and locked bond is <Usd value={gap} /> above the minimum of{" "}
              <Usd value={minimum} /> the risk model asks for.
            </>
          ) : (
            <>
              <span aria-hidden="true" className="text-warn">
                ▲{" "}
              </span>
              <span className="text-warn">Below minimum</span>: top up <Usd value={-gap} /> to reach{" "}
              <Usd value={minimum} />.
            </>
          )}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={() => setSheet(true)}>
            Deposit PYUSD
          </Button>
          <span className="text-muted-foreground text-xs">
            Signed in your wallet, sent by Keelson: no gas. {bond.bond.slashCount} slashes so far.
          </span>
        </div>
      </section>

      <section aria-labelledby="grade" className="rounded-[10px] border p-5">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="grade" className="font-semibold">
            Trust grade and premium
          </h2>
          <span className="text-muted-foreground text-xs" aria-live="polite">
            Updated {ago(grade.computedAt, now)} · live
          </span>
        </div>
        <div className="mt-3 flex items-center gap-4">
          <span
            data-testid="grade"
            className="grid size-14 place-items-center rounded-[6px] border-2 border-foreground font-mono font-semibold text-3xl"
          >
            {grade.grade}
          </span>
          <div className="grid gap-0.5">
            <span className="font-medium">{g.word}</span>
            <span className="text-muted-foreground text-sm">
              Incident rate at most {pct(grade.frequency.upper95_ppm)} (95 % bound), from{" "}
              {grade.evidence.coverages.toLocaleString("en-US")} coverages and {incidents} incident
              {incidents === 1 ? "" : "s"}.
            </span>
          </div>
        </div>
        <DataList className="mt-3">
          <DataItem label="Premium per coverage">
            <span className="font-mono tabular-nums" data-testid="premium">
              {grade.premium.bps} bps
            </span>
          </DataItem>
          <DataItem label="Model price · floor">
            <span className="font-mono tabular-nums">
              {grade.premium.modelBps} bps · {grade.premium.floorBps} bps
            </span>
          </DataItem>
          <DataItem label={`Expected loss, next ${grade.loss.horizon} coverages`}>
            <Amount value={major(grade.loss.expectedMinor, "USD")} />
          </DataItem>
          <DataItem label="Loss at 99 %">
            <Amount value={major(grade.loss.var99Minor, "USD")} />
          </DataItem>
          <DataItem label="Keelson's own faults, paid by its reserve (not graded)">
            <span className="font-mono tabular-nums">{grade.reserve.warranties}</span>
          </DataItem>
        </DataList>
        <p className="mt-3 text-muted-foreground text-xs">
          {Number.isFinite(g.ceilingPpm)
            ? `Grade ${grade.grade} holds while the bound stays at or below ${pct(g.ceilingPpm)}. `
            : ""}
          Each covered purchase updates it; a verdict with the operator at fault moves it most.
        </p>
      </section>

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
