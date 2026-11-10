"use client";

import { Button } from "@keelson/ui/components/button";
import { Status } from "@keelson/ui/components/status";
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

/** Sign → Check → Pay → Dispute → Resolve, with who acted at each step. */
function Steps({ p }: { p: Purchase }) {
  const blocked = p.state === "DENIED";
  const paid = CAPTURED.has(p.state);
  const disputed = p.disputes.length > 0;
  const resolved = p.disputes.length > 0 && p.disputes.every((d) => d.state !== "OPEN");
  const steps = [
    { name: "Sign", who: "You, with your passkey", done: true },
    {
      name: "Check",
      who: blocked ? "Keelson blocked the cart before payment" : "Keelson countersigned the cart",
      done: p.state !== "PROPOSED" && p.state !== "EVALUATING",
    },
    {
      name: "Pay",
      who: blocked
        ? "Nothing was paid"
        : p.failure
          ? `Stopped at ${p.failure.step}: nothing was captured`
          : "PayPal captured the amount",
      done: paid,
    },
    ...(disputed
      ? [
          { name: "Dispute", who: "Opened on PayPal", done: true },
          { name: "Resolve", who: "Keelson attributes the field at fault", done: resolved },
        ]
      : []),
  ];
  return (
    <ol className="grid gap-0">
      {steps.map((s, i) => (
        <li key={s.name} className="grid grid-cols-[1.25rem_1fr] gap-x-4">
          <span className="flex flex-col items-center">
            <span
              aria-hidden="true"
              className={`mt-1.5 size-2.5 rounded-full border-2 ${s.done ? "border-foreground bg-foreground" : "border-border"}`}
            />
            {i < steps.length - 1 ? (
              <span aria-hidden="true" className="w-px flex-1 bg-border" />
            ) : null}
          </span>
          <span className="grid gap-0.5 pb-5">
            <span className="font-medium">
              {s.name}
              <span className="sr-only">{s.done ? ", done" : ", pending"}</span>
            </span>
            <span className="text-muted-foreground text-sm">{s.who}</span>
          </span>
        </li>
      ))}
    </ol>
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
          <h1 className="tnum font-semibold text-5xl tracking-[-0.035em]">
            {money(p.amount.minor, p.amount.currency)}
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
        <dl className="grid gap-3 font-mono text-sm">
          <div className="grid gap-0.5">
            <dt className="text-muted-foreground text-xs uppercase tracking-[0.14em]">Alibi id</dt>
            <dd className="break-all">{p.id}</dd>
          </div>
          {logged ? (
            <div className="grid gap-0.5">
              <dt className="text-muted-foreground text-xs uppercase tracking-[0.14em]">
                Log entry
              </dt>
              <dd>#{p.logIndex}</dd>
            </div>
          ) : null}
          {p.capture ? (
            <div className="grid gap-0.5">
              <dt className="text-muted-foreground text-xs uppercase tracking-[0.14em]">
                PayPal capture
              </dt>
              <dd className="break-all">{p.capture.id}</dd>
            </div>
          ) : null}
          {p.mode ? (
            <div className="grid gap-0.5">
              <dt className="text-muted-foreground text-xs uppercase tracking-[0.14em]">
                Countersigned by
              </dt>
              <dd>
                {p.mode === "2of2" ? "Both attested engines" : "One attested engine (degraded)"}
              </dd>
            </div>
          ) : null}
        </dl>
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
