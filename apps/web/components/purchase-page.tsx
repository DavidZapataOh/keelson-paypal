"use client";

import type { Card } from "@keelson/mandate/browser";
import { Amount } from "@keelson/ui/components/amount";
import { BlockDiff } from "@keelson/ui/components/block-diff";
import { Button } from "@keelson/ui/components/button";
import { CopyValue } from "@keelson/ui/components/copy-value";
import { DataItem, DataList } from "@keelson/ui/components/data-list";
import { Status } from "@keelson/ui/components/status";
import { Timeline, TimelineItem } from "@keelson/ui/components/timeline";
import { Check, ChevronRight, MessageSquareWarning, X } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { get } from "../lib/api";
import { API, VERIFY } from "../lib/config";
import { DISPUTE_KINDS, kindOf } from "../lib/dispute-kinds";
import { major, money, when } from "../lib/format";
import { purchaseStatus } from "../lib/status";
import type { Dispute, Purchase } from "../lib/types";
import { useMandate } from "../lib/use-mandate";
import { AnonymousProof } from "./anonymous-proof";
import { AppShell } from "./app-shell";
import { RiveMoment } from "./brand";
import { DisputeSheet } from "./dispute-sheet";
import { ErrorNotice } from "./notice";

const PARTY = {
  operator: "The agent's operator, from its bond",
  keelson: "Keelson, from its reserve",
  merchant: "The store, through PayPal",
  user: "You",
} as const;

const CAPTURED = new Set([
  "CAPTURED",
  "DELIVERED",
  "SETTLED",
  "DISPUTED",
  "ATTRIBUTED",
  "SLASHED",
  "WARRANTY_PAID",
  "DEFENDED",
  "MERCHANT_LIABLE",
]);

/** One line per field that failed its check: what the mandate allows against the cart. */
function Blocks({ p, card }: { p: Purchase; card: Card | null }) {
  if (!p.blocked?.length) return null;
  return (
    <div className="mt-2 grid gap-1">
      {p.blocked.map((field) => {
        const row = card?.rows.find((r) => r.field === field);
        const reason = p.reasons?.find((r) => r.field === field);
        return (
          <BlockDiff
            key={field}
            field={row?.label ?? field.replaceAll("_", " ")}
            mandate={reason?.mandate ?? (row ? row.values.join(", ") : "as signed")}
            cart={
              reason?.cart ??
              (field === "total" ? money(p.amount.minor, p.amount.currency) : "not as signed")
            }
          />
        );
      })}
    </div>
  );
}

/** Sign → Check → Pay → Dispute → Resolve: who acted at each step, and when. */
function Steps({ p }: { p: Purchase }) {
  const checking = p.state === "PROPOSED" || p.state === "EVALUATING";
  const blocked = p.state === "DENIED";
  const paid = CAPTURED.has(p.state);
  const amount = money(p.amount.minor, p.amount.currency);
  // The timeline closes on the outcome once nothing is still moving.
  const settled = p.disputes.every((d) => d.state === "RESOLVED");
  const outcome =
    blocked || p.failure
      ? "nothing was paid"
      : paid && settled
        ? p.disputes.length > 0
          ? `${amount} paid; the dispute is closed`
          : `${amount} paid`
        : undefined;
  return (
    <Timeline aria-label="What happened">
      <TimelineItem state="done" actor="You">
        signed the mandate with your passkey
      </TimelineItem>
      {checking ? (
        <TimelineItem state="current" actor="Keelson">
          is checking the cart against your mandate
        </TimelineItem>
      ) : blocked ? (
        <TimelineItem state="blocked" actor="Keelson" time={p.createdAt}>
          blocked the cart before payment
        </TimelineItem>
      ) : (
        <TimelineItem state="done" actor="Keelson" time={p.createdAt}>
          countersigned the cart
        </TimelineItem>
      )}
      {blocked ? null : p.failure ? (
        <TimelineItem state="failed" actor="Keelson">
          stopped at {p.failure.step}: nothing was captured{" "}
          <span className="font-mono text-muted-foreground text-xs">{p.failure.reason}</span>
        </TimelineItem>
      ) : paid ? (
        <TimelineItem state="done" actor="PayPal">
          captured {amount}
        </TimelineItem>
      ) : (
        <TimelineItem state={checking ? "upcoming" : "current"} actor="PayPal">
          captures {amount} once the Alibi is sealed
        </TimelineItem>
      )}
      {p.disputes.map((d) => (
        <TimelineItem key={d.id} state={d.state === "OPEN" ? "current" : "done"} actor="PayPal">
          dispute {d.id}{" "}
          {d.state === "OPEN" ? "is open; Keelson is attributing it" : "has been attributed"}
        </TimelineItem>
      ))}
      {outcome ? (
        <TimelineItem state="done" actor="Outcome">
          {outcome}
        </TimelineItem>
      ) : null}
    </Timeline>
  );
}

function DisputeCard({ id }: { id: string }) {
  const [d, setD] = useState<Dispute>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    get<Dispute>(`/v1/disputes/${encodeURIComponent(id)}`).then(setD, (e: Error) =>
      setError(e.message),
    );
  }, [id]);
  if (error) return <ErrorNotice>{error}</ErrorNotice>;
  if (!d) return null;
  const refunded = Boolean(d.settlement?.refund_id);
  return (
    <section
      aria-label={`Dispute ${d.dispute_id}`}
      className="grid gap-3 rounded-3xl border bg-card p-5 sm:p-6"
    >
      <div className="flex items-center gap-4">
        <RiveMoment
          artboard="Refund"
          play={refunded}
          className="size-16 shrink-0"
          still={
            <span
              className={`size-5 rounded-full ${refunded ? "bg-ok" : "animate-pending bg-foreground"}`}
            />
          }
        />
        <div className="grid min-w-0 gap-0.5">
          <p className="font-semibold">
            {refunded
              ? "Refunded to your PayPal"
              : d.liable
                ? `${PARTY[d.liable]} answers`
                : "Keelson is reading the evidence"}
          </p>
          <p className="text-muted-foreground text-xs">
            {DISPUTE_KINDS[kindOf(d)].label} · <span className="font-mono">{d.dispute_id}</span>
          </p>
        </div>
      </div>
      <p className="text-muted-foreground text-sm">
        PayPal reason: {d.reason.replaceAll("_", " ").toLowerCase()}
        {d.verdict ? ` · rule ${d.verdict.rule}` : ""}
        {d.elapsed_ms !== null ? ` · attributed in ${(d.elapsed_ms / 1000).toFixed(1)} s` : ""}
      </p>
      {d.settlement?.refund_id ? <p className="text-sm">Refund {d.settlement.refund_id}</p> : null}
      <p className="text-muted-foreground text-xs">PayPal still decides disputes.</p>
    </section>
  );
}

async function download(path: string, name: string) {
  const res = await fetch(`${API}${path}`, { credentials: "include" });
  if (!res.ok) throw new Error("The Alibi is not ready yet.");
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

/** The store's name as the signed card spells it. */
function storeName(card: Card | null, id: string): string {
  const names = (card?.rows.find((r) => r.field === "merchant")?.values ?? []).map(
    (v) => v.split(" (")[0] ?? v,
  );
  const bare = id.replace(/^mrc_/, "");
  return (
    names.find((n) => n.toLowerCase().replace(/\W/g, "") === bare.replace(/\W/g, "")) ??
    bare.charAt(0).toUpperCase() + bare.slice(1)
  );
}

export function PurchasePage() {
  return (
    <AppShell>
      <Receipt />
    </AppShell>
  );
}

function Receipt() {
  const params = useSearchParams();
  const { mandate, error } = useMandate(params.get("mandate"));
  const [fileError, setFileError] = useState<string>();
  const [disputing, setDisputing] = useState(false);
  if (error) return <ErrorNotice>{error}</ErrorNotice>;
  const p = mandate?.purchases.find((x) => x.id === params.get("id"));
  if (!mandate)
    return (
      <p role="status" className="sr-only">
        Loading…
      </p>
    );
  if (!p) return <ErrorNotice>No such purchase in this mandate.</ErrorNotice>;
  const logged = p.logIndex !== undefined;
  // The Alibi is issued, and verified, when the leaf is logged: before a capture, and for a
  // blocked cart too. A purchase that failed before its Alibi has none.
  const sealed = !p.failure && (CAPTURED.has(p.state) || (p.state === "DENIED" && logged));
  const blocked = p.state === "DENIED";
  const store = storeName(mandate.card, p.merchantId);

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[1fr_400px]">
      <section className="grid content-start gap-6">
        <Link
          href="/"
          className="w-fit py-2 text-muted-foreground text-sm underline-offset-4 hover:underline"
        >
          ← Home
        </Link>
        <div className="flex items-center gap-4">
          <span
            className={`grid size-14 shrink-0 place-items-center rounded-2xl font-semibold text-xl ${blocked ? "bg-vermilion text-graphite" : "bg-graphite text-bone"}`}
          >
            {store.charAt(0)}
          </span>
          <div className="grid min-w-0 gap-1">
            <p className="truncate font-medium text-lg">{store}</p>
            <div className="flex flex-wrap items-center gap-3 text-muted-foreground text-sm">
              <Status state={purchaseStatus(p)} />
              <span>{when(p.createdAt)}</span>
            </div>
          </div>
        </div>
        <h1>
          <Amount
            value={major(p.amount.minor, p.amount.currency)}
            currency={p.amount.currency}
            className="text-[3rem]"
            {...(p.failure || blocked ? { struck: "Not paid" } : {})}
          />
        </h1>

        {blocked ? (
          <div className="flex gap-4 rounded-3xl border border-vermilion/35 bg-vermilion/[0.06] p-5">
            <RiveMoment
              artboard="Blocked"
              play
              className="size-20 shrink-0"
              still={<span className="size-6 rounded-[4px] bg-vermilion" />}
            />
            <div className="grid min-w-0 content-center gap-2">
              <p className="font-semibold">Keelson stopped this cart. Nothing was paid.</p>
              <Blocks p={p} card={mandate.card} />
            </div>
          </div>
        ) : null}

        {!blocked && CAPTURED.has(p.state) && p.disputes.length === 0 ? (
          <button
            type="button"
            onClick={() => setDisputing(true)}
            className="flex items-center gap-4 rounded-3xl border bg-card p-5 text-left transition-colors hover:bg-foreground/4"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-bone-2">
              <MessageSquareWarning className="size-5" aria-hidden="true" />
            </span>
            <span className="grid flex-1 leading-snug">
              <span className="font-semibold">Not what you asked for?</span>
              <span className="text-muted-foreground text-sm">
                See who answers, then dispute it
              </span>
            </span>
            <ChevronRight className="size-5 text-muted-foreground" aria-hidden="true" />
          </button>
        ) : null}

        <div className="rounded-3xl border bg-card p-5 sm:p-6">
          <h2 className="mb-4 font-semibold text-lg">What happened</h2>
          <Steps p={p} />
        </div>
        {p.checks?.length ? (
          <div className="rounded-3xl border bg-card p-5 sm:p-6">
            <h2 className="mb-3 font-semibold text-lg">What Keelson checked</h2>
            <ul className="grid divide-y" aria-label="What Keelson checked">
              {p.checks.map((c) => (
                <li key={c.field} className="flex items-center gap-3 py-2.5 text-sm">
                  <span
                    className={`grid size-5 shrink-0 place-items-center rounded-[4px] ${c.pass ? "bg-ok text-bone" : "bg-vermilion text-graphite"}`}
                  >
                    {c.pass ? (
                      <Check className="size-3.5" strokeWidth={3} aria-label="held" />
                    ) : (
                      <X className="size-3.5" strokeWidth={3} aria-label="failed" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {mandate.card?.rows.find((r) => r.field === c.field)?.label ?? c.field}
                  </span>
                  <span className="font-mono tnum">
                    {c.cart ?? "—"}{" "}
                    <span className="text-muted-foreground">{c.pass ? "within" : "outside"}</span>{" "}
                    {c.mandate ?? "—"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {p.disputes.map((d) => (
          <DisputeCard key={d.id} id={d.id} />
        ))}
        {mandate.card ? (
          <DisputeSheet
            open={disputing}
            onOpenChange={setDisputing}
            card={mandate.card}
            alibiId={p.id}
          />
        ) : null}
      </section>

      <section
        className="grid content-start gap-5 rounded-3xl border bg-card p-5 sm:p-6"
        aria-labelledby="alibi"
      >
        <h2 id="alibi" className="font-semibold text-lg">
          Alibi
        </h2>
        <p className="text-muted-foreground text-sm">
          The sealed record of this purchase: your mandate, the cart, the check and the payment.
          Anyone can verify it; nobody can rewrite it.
        </p>
        <DataList layout="stacked">
          <DataItem label="Alibi id">
            <CopyValue value={p.id} label="Alibi id" />
          </DataItem>
          {logged ? <DataItem label="Log entry">#{p.logIndex}</DataItem> : null}
          {p.capture ? (
            <DataItem label="PayPal capture">
              <CopyValue value={p.capture.id} label="PayPal capture id" />
            </DataItem>
          ) : null}
          {p.mode ? (
            <DataItem label="Countersigned by">
              {p.mode === "2of2" ? "Both attested engines" : "One attested engine (degraded)"}
            </DataItem>
          ) : null}
        </DataList>
        {sealed ? (
          <div className="grid gap-3">
            <Button asChild>
              <a href={`${VERIFY}/a/${p.id}`} target="_blank" rel="noopener">
                Verify in your browser
              </a>
            </Button>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() =>
                  download(`/v1/alibis/${p.id}.pdf`, `${p.id}.pdf`).catch((e: Error) =>
                    setFileError(e.message),
                  )
                }
              >
                Download PDF
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  download(`/v1/alibis/${p.id}`, `${p.id}.alibi`).catch((e: Error) =>
                    setFileError(e.message),
                  )
                }
              >
                Download .alibi
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              The link checks the public log entry. Drop the .alibi file into the verifier to check
              everything else.
            </p>
          </div>
        ) : p.failure ? (
          <p className="text-muted-foreground text-sm">
            No Alibi was issued for this cart (stopped at {p.failure.step}). Nothing was captured.
          </p>
        ) : (
          <p className="text-muted-foreground text-sm" role="status">
            The Alibi is sealed once the cart is written to the log.
          </p>
        )}
        {fileError ? <ErrorNotice>{fileError}</ErrorNotice> : null}
        {sealed ? <AnonymousProof id={p.id} createdAt={p.createdAt} /> : null}
      </section>
    </div>
  );
}
