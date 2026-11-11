"use client";

import { Badge } from "@keelson/ui/components/badge";
import { CopyValue } from "@keelson/ui/components/copy-value";
import { DataItem, DataList } from "@keelson/ui/components/data-list";
import { Skeleton } from "@keelson/ui/components/skeleton";
import { Status } from "@keelson/ui/components/status";
import { Timeline, TimelineItem } from "@keelson/ui/components/timeline";
import { useEffect, useState } from "react";
import { type LogBond, logBonds, pyusd } from "../lib/log-bonds";
import { ErrorNotice } from "./notice";

/** The bonds on the log keys, read from the API; `test` picks the drill's bond or the live origins'. */
function useLogBonds() {
  const [bonds, setBonds] = useState<LogBond[] | { error: string }>();
  useEffect(() => {
    logBonds().then(
      (r) => setBonds(r.bonds),
      (e: Error) => setBonds({ error: e.message }),
    );
  }, []);
  return bonds;
}

function SignedNote({ label, note }: { label: string; note: string }) {
  return (
    <figure className="grid min-w-0 gap-1.5">
      <figcaption className="text-muted-foreground text-xs">{label}</figcaption>
      <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
        {note}
      </pre>
    </figure>
  );
}

/** One bond: what it holds, the key it pins, and the equivocation that slashed it, if any. */
function LogBondCard({ bond }: { bond: LogBond }) {
  const e = bond.equivocation;
  return (
    <article className="grid gap-5 rounded-lg border bg-card p-5">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="font-mono text-sm">{bond.origin}</h3>
        {bond.test ? <Badge variant="outline">Test origin · drill</Badge> : null}
        <span className="ml-auto">
          {e ? (
            <Status state="bond-slashed" />
          ) : (
            <Badge variant="outline" className="font-mono">
              Bonded
            </Badge>
          )}
        </span>
      </header>
      <DataList layout="row">
        <DataItem label="Held now">{pyusd(bond.balanceMinor)}</DataItem>
        <DataItem label="Log key (Ed25519)">
          <CopyValue value={bond.key} label="log key" short />
        </DataItem>
        <DataItem label="Contract">
          <a
            className="font-mono text-sm underline"
            href={bond.explorerUrl}
            target="_blank"
            rel="noopener"
          >
            {bond.address.slice(0, 6)}…{bond.address.slice(-4)} ↗
          </a>
        </DataItem>
        <DataItem label="On a slash">
          {bond.bountyBps / 100}% to the prover, the rest to Keelson&apos;s reserve
        </DataItem>
        <DataItem label="Withdrawal delay">
          {Math.round(bond.withdrawalDelaySeconds / 86_400)} days
        </DataItem>
      </DataList>
      {!bond.canonical ? (
        <ErrorNotice>
          This bond does not call Keelson&apos;s Ed25519 verifier over PYUSD, so a slash of it
          proves nothing.
        </ErrorNotice>
      ) : null}
      {e ? (
        <div className="grid gap-4">
          <Timeline>
            <TimelineItem state="done" actor="The log">
              signed tree size {e.size} with root{" "}
              <span className="font-mono text-xs">{e.rootA.slice(0, 10)}…</span>
            </TimelineItem>
            <TimelineItem state="done" actor="The log">
              signed the same size with root{" "}
              <span className="font-mono text-xs">{e.rootB.slice(0, 10)}…</span>
            </TimelineItem>
            <TimelineItem
              state="blocked"
              actor="LogBond"
              time={e.provenAt}
              {...(e.explorerUrl ? { proof: { href: e.explorerUrl, label: "Arbiscan" } } : {})}
            >
              verified both Ed25519 signatures on chain and slashed {pyusd(e.amountMinor)}:{" "}
              {pyusd(e.bountyMinor)} to the prover{" "}
              <span className="font-mono text-xs">
                {e.prover.slice(0, 6)}…{e.prover.slice(-4)}
              </span>
              , the rest to Keelson&apos;s reserve
            </TimelineItem>
          </Timeline>
          {e.noteA && e.noteB ? (
            <div className="grid gap-3 lg:grid-cols-2">
              <SignedNote label="Checkpoint A" note={e.noteA} />
              <SignedNote label="Checkpoint B" note={e.noteB} />
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          No equivocation proven. Anyone holding two checkpoints of this key with different roots
          for one size can call <span className="font-mono">proveEquivocation</span>: the bond is
          slashed, {bond.bountyBps / 100}% of it to them.
        </p>
      )}
    </article>
  );
}

/** Every log bond, or the ones `filter` keeps. */
export function LogBonds({ filter }: { filter?: (b: LogBond) => boolean }) {
  const bonds = useLogBonds();
  if (!bonds) return <Skeleton className="h-64 w-full rounded-lg" />;
  if ("error" in bonds) return <ErrorNotice>{bonds.error}</ErrorNotice>;
  const shown = filter ? bonds.filter(filter) : bonds;
  return (
    <div className="grid gap-4">
      {shown.map((b) => (
        <LogBondCard key={b.address} bond={b} />
      ))}
    </div>
  );
}
