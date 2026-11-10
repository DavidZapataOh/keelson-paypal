"use client";

import { Amount } from "@keelson/ui/components/amount";
import { Button } from "@keelson/ui/components/button";
import { CopyValue } from "@keelson/ui/components/copy-value";
import { DataItem, DataList } from "@keelson/ui/components/data-list";
import { Status } from "@keelson/ui/components/status";
import { Timeline, TimelineItem } from "@keelson/ui/components/timeline";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { get } from "../lib/api";
import { API, VERIFY } from "../lib/config";
import { money, when } from "../lib/format";
import { purchaseStatus } from "../lib/status";
import type { Dispute, Purchase } from "../lib/types";
import { useMandate } from "../lib/use-mandate";
import { ErrorNotice, Eyebrow } from "./notice";

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

/** Sign → Check → Pay → Dispute → Resolve: who acted at each step, and when. */
function Steps({ p }: { p: Purchase }) {
  const checking = p.state === "PROPOSED" || p.state === "EVALUATING";
  const blocked = p.state === "DENIED";
  const paid = CAPTURED.has(p.state);
  const amount = money(p.amount.minor, p.amount.currency);
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
  return (
    <div className="grid gap-2 rounded-xl border p-5">
      <p className="font-mono text-muted-foreground text-xs">{d.dispute_id}</p>
      <p className="font-medium">
        {d.liable ? `Liable: ${PARTY[d.liable]}` : "Keelson is reading the evidence."}
      </p>
      <p className="text-muted-foreground text-sm">
        PayPal reason: {d.reason.replaceAll("_", " ").toLowerCase()}
        {d.verdict ? ` · rule ${d.verdict.rule}` : ""}
        {d.elapsed_ms !== null ? ` · attributed in ${(d.elapsed_ms / 1000).toFixed(1)} s` : ""}
      </p>
      {d.settlement?.refund_id ? (
        <p className="text-sm">Refund {d.settlement.refund_id} sent to you on PayPal.</p>
      ) : null}
      <p className="text-muted-foreground text-xs">PayPal still decides disputes.</p>
    </div>
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

export function PurchasePage() {
  const params = useSearchParams();
  const { mandate, error } = useMandate(params.get("mandate"));
  const [fileError, setFileError] = useState<string>();
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

  return (
    <div className="grid gap-10 md:grid-cols-[1.1fr_1fr] md:gap-16">
      <section className="grid content-start gap-6">
        <Link
          href={`/mandate/?id=${mandate.id}`}
          className="w-fit py-2 text-muted-foreground text-sm underline-offset-4 hover:underline"
        >
          ← Mandate {mandate.id.slice(-8)}
        </Link>
        <div className="grid gap-3">
          <Eyebrow>{p.merchantId}</Eyebrow>
          <h1>
            <Amount
              value={Number(p.amount.minor) / 100}
              currency={p.amount.currency}
              className="text-amount"
              {...(p.failure || p.state === "DENIED" ? { struck: "Not paid" } : {})}
            />
          </h1>
          <div className="flex flex-wrap items-center gap-3 text-muted-foreground text-sm">
            <Status state={purchaseStatus(p)} />
            <span>{when(p.createdAt)}</span>
          </div>
        </div>
        <Steps p={p} />
        {p.disputes.map((d) => (
          <DisputeCard key={d.id} id={d.id} />
        ))}
      </section>

      <section
        className="grid content-start gap-5 rounded-xl border bg-card p-6"
        aria-labelledby="alibi"
      >
        <h2 id="alibi" className="font-semibold text-xl">
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
      </section>
    </div>
  );
}
