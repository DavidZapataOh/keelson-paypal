"use client";

import { MCC_LABELS } from "@keelson/mandate/browser";
import { Amount } from "@keelson/ui/components/amount";
import { Button } from "@keelson/ui/components/button";
import { CopyValue } from "@keelson/ui/components/copy-value";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@keelson/ui/components/empty";
import { Skeleton } from "@keelson/ui/components/skeleton";
import { Status } from "@keelson/ui/components/status";
import { CreditCard } from "lucide-react";
import { useEffect, useState } from "react";
import { VERIFY } from "../lib/config";
import { major, when } from "../lib/format";
import { alibiUrl, type LivePurchase, livePurchases, reasonOf } from "../lib/live";
import { AmountAuthorityLine } from "./amount-authority";
import { CheckoutBreakdown } from "./checkout-breakdown";
import { ConversionLine } from "./conversion-line";
import { ErrorNotice } from "./notice";

const host = (origin: string) => new URL(origin).hostname.replace(/^www\./, "");

function Entry({ p }: { p: LivePurchase }) {
  const denied = p.decision === "deny";
  return (
    <li className="grid gap-x-8 gap-y-3 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-6">
      <div className="grid min-w-0 gap-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Amount
            value={major(p.amount.minor, p.amount.currency)}
            currency={p.amount.currency}
            className="text-xl"
            {...(denied ? { struck: "Not paid" } : {})}
          />
          <span className="text-muted-foreground">at</span>
          {p.store ? (
            <a
              href={p.store}
              target="_blank"
              rel="noopener"
              className="font-medium underline decoration-border underline-offset-4 hover:decoration-foreground"
            >
              {host(p.store)}
            </a>
          ) : (
            <span className="font-medium">{p.card?.merchantName ?? "a card merchant"}</span>
          )}
        </div>
        <CheckoutBreakdown amount={p.amount} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-sm">
          <Status state={denied ? "blocked" : "countersigned"} />
          <time dateTime={p.createdAt}>{when(p.createdAt)}</time>
          <span className="tabular-nums">Log entry {p.logIndex}</span>
        </div>
        {denied ? (
          <p className="text-sm">
            {p.blocked.length > 0 ? `${p.blocked.map(reasonOf).join(". ")}. ` : ""}
            <span className="text-muted-foreground">
              The agent's pay click was held; nothing was charged.
            </span>
          </p>
        ) : p.card ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <CreditCard className="size-4" aria-hidden="true" />
            <span>
              Paid with PayPal · Keelson single-use card •••• {p.card.lastFour}
              {p.card.mcc ? ` at ${MCC_LABELS[p.card.mcc] ?? `MCC ${p.card.mcc}`}` : ""}
            </span>
            <span className="text-muted-foreground">
              {p.card.approved > 0 ? "both enclaves approved the charge" : "not charged yet"}
              {p.card.declined > 0
                ? `; ${p.card.declined} other ${p.card.declined === 1 ? "charge" : "charges"} declined`
                : ""}
            </span>
          </p>
        ) : p.transactionId ? (
          <>
            {p.amountAuthority ? (
              <AmountAuthorityLine
                a={p.amountAuthority}
                {...(p.store ? { store: host(p.store) } : {})}
              />
            ) : null}
            {p.conversion ? <ConversionLine conversion={p.conversion} /> : null}
            <p className="flex flex-wrap items-center gap-x-2 text-sm">
              <span className="text-muted-foreground">Paid through PayPal, transaction</span>
              <CopyValue value={p.transactionId} label="PayPal transaction id" />
            </p>
          </>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Button asChild size="sm" variant="outline">
          <a href={`${VERIFY}/a/${p.id}`} target="_blank" rel="noopener">
            Verify the Alibi
          </a>
        </Button>
        <Button asChild size="sm" variant="ghost">
          <a href={alibiUrl(p.id)} download={`${p.id}.alibi`}>
            Download
          </a>
        </Button>
      </div>
    </li>
  );
}

export function LivePurchases() {
  const [list, setList] = useState<LivePurchase[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    livePurchases()
      .then(setList)
      .catch(() => setError("The live purchases could not be loaded. Try again in a moment."));
  }, []);

  if (error) return <ErrorNotice>{error}</ErrorNotice>;
  if (!list) {
    return (
      <div className="grid gap-px overflow-hidden rounded-xl border" aria-busy="true">
        <Skeleton className="h-28 rounded-none" />
        <Skeleton className="h-28 rounded-none" />
      </div>
    );
  }
  if (list.length === 0) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyTitle>No live purchase yet</EmptyTitle>
          <EmptyDescription>
            When the agent pays at a real store, the purchase shows here with its PayPal transaction
            or its single-use card, and its Alibi. A cart Keelson blocks before the payment shows
            here too.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <section aria-labelledby="live-list" className="grid gap-3">
      <h2 id="live-list" className="sr-only">
        Live purchases and blocked carts
      </h2>
      <ol className="grid divide-y rounded-xl border bg-card">
        {list.map((p) => (
          <Entry key={p.id} p={p} />
        ))}
      </ol>
    </section>
  );
}
