"use client";

import { Amount } from "@keelson/ui/components/amount";
import { Empty, EmptyDescription, EmptyHeader } from "@keelson/ui/components/empty";
import { Meter } from "@keelson/ui/components/meter";
import { Status } from "@keelson/ui/components/status";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { post } from "../lib/api";
import { major, money, when } from "../lib/format";
import { mandateLabel, purchaseStatus } from "../lib/status";
import { useMandate } from "../lib/use-mandate";
import { AppShell } from "./app-shell";
import { HoldButton } from "./hold-button";
import { LiveView } from "./live-view";
import { MandateCard } from "./mandate-card";
import { MandateVisual } from "./mandate-visual";
import { ErrorNotice } from "./notice";
import { PayPalHold } from "./paypal-hold";

export function MandatePage() {
  return (
    <AppShell>
      <MandateDetail />
    </AppShell>
  );
}

function MandateDetail() {
  const id = useSearchParams().get("id");
  const { mandate, error, pending, countersigned, liveView, reload, signedIn, sessionPending } =
    useMandate(id);
  const [revoking, setRevoking] = useState(false);

  if (!sessionPending && !signedIn) {
    return (
      <p>
        <Link href="/" className="underline underline-offset-4">
          Sign in
        </Link>{" "}
        to see this mandate.
      </p>
    );
  }
  if (error) return <ErrorNotice>{error}</ErrorNotice>;
  if (!mandate)
    return (
      <p role="status" className="sr-only">
        Loading…
      </p>
    );

  const { budget } = mandate;
  const max = major(budget.maxMinor, budget.currency);
  const left = major(budget.remainingMinor, budget.currency);
  const dollars = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: budget.currency }).format(n);
  const needsHold =
    (mandate.state === "SIGNED" || mandate.state === "HOLD_PENDING") &&
    mandate.hold?.mode !== "per_purchase";
  const open =
    mandate.state === "SIGNED" || mandate.state === "HOLD_PENDING" || mandate.state === "ACTIVE";

  const revoke = async () => {
    setRevoking(true);
    await post(`/v1/mandates/${mandate.id}/revoke`).catch(() => {});
    setRevoking(false);
    void reload();
  };

  return (
    <div className="grid gap-8">
      <section
        className="grid items-center gap-8 lg:grid-cols-[1fr_400px]"
        aria-labelledby="budget"
      >
        <div className="grid gap-5">
          <Link
            href="/"
            className="w-fit py-2 text-muted-foreground text-sm underline-offset-4 hover:underline"
          >
            ← Home
          </Link>
          <h1 id="budget" className="grid gap-1">
            <span className="font-normal text-base text-muted-foreground">
              {mandateLabel(mandate.state)} · your agent may still spend
            </span>
            <Amount value={left} currency={budget.currency} className="text-[3rem]" />
          </h1>
          <Meter label="Spent" value={max - left} max={max} format={dollars} className="max-w-md" />
          <p className="text-muted-foreground text-sm">Valid until {when(mandate.expiresAt)}</p>
        </div>
        <MandateVisual
          className="mx-auto max-w-[400px]"
          amount={max}
          currency={budget.currency}
          amountLabel="Up to"
          what={
            mandate.card?.rows.find((r) => r.field === "items")?.values.join(", ") ??
            mandate.card?.rows.find((r) => r.field === "summary")?.values[0] ??
            ""
          }
          chips={(
            mandate.card?.rows.find((r) => r.field === "merchant")?.values ?? ["Any store"]
          ).map((m) => m.split(" (")[0] ?? m)}
          until={new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(
            new Date(mandate.expiresAt),
          )}
          state={mandateLabel(mandate.state)}
          seal="closed"
        />
      </section>

      {liveView && mandate.state === "ACTIVE" ? <LiveView url={liveView} /> : null}

      {needsHold ? (
        <section
          className="grid max-w-xl gap-4 rounded-3xl border bg-card p-6"
          aria-labelledby="hold"
        >
          <h2 id="hold" className="font-semibold text-xl">
            Approve the hold on PayPal
          </h2>
          <p className="text-muted-foreground">
            PayPal holds {money(budget.maxMinor, budget.currency)} on your account. Nothing is
            charged until a cart passes the check, and only that cart's amount is captured. The rest
            is released when the mandate ends.
          </p>
          <PayPalHold
            target={{ kind: "mandate", mandateId: mandate.id }}
            currency={budget.currency}
            onAuthorized={reload}
          />
        </section>
      ) : null}

      {pending.map((p) => (
        <section key={p.requestId} className="grid max-w-xl gap-4 rounded-3xl border bg-card p-6">
          <h2 className="font-semibold text-xl">
            Approve {money(p.amountMinor, budget.currency)} at {p.merchant}
          </h2>
          <p className="text-muted-foreground">
            This cart passed the check. Approve it on PayPal and it is paid.
          </p>
          <PayPalHold
            target={{
              kind: "purchase",
              mandateId: mandate.id,
              requestId: p.requestId,
              orderId: p.orderId,
            }}
            currency={budget.currency}
            onAuthorized={reload}
          />
        </section>
      ))}

      <section className="grid gap-4" aria-labelledby="purchases">
        <div className="flex items-baseline justify-between">
          <h2 id="purchases" className="font-semibold text-xl">
            Purchases
          </h2>
          {mandate.state === "ACTIVE" ? (
            <span className="text-muted-foreground text-sm" role="status">
              Live: new carts appear as your agent checks out.
            </span>
          ) : null}
        </div>
        {mandate.purchases.length === 0 ? (
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyDescription>
                {mandate.state === "ACTIVE"
                  ? "No purchases yet. When your agent checks out, the cart shows here with Keelson's decision."
                  : "Purchases start once the hold is approved."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="grid divide-y rounded-3xl border bg-card">
            {mandate.purchases.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/purchase/?mandate=${mandate.id}&id=${p.id}`}
                  className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 px-5 py-4 hover:bg-accent/60"
                >
                  <span className="font-medium">{p.merchantId}</span>
                  <Amount
                    value={major(p.amount.minor, p.amount.currency)}
                    currency={p.amount.currency}
                    className="text-right"
                  />
                  <span className="text-muted-foreground text-sm">{when(p.createdAt)}</span>
                  <span className="justify-self-end">
                    <Status
                      state={purchaseStatus(p)}
                      appearance="inline"
                      reveal={countersigned.has(p.id) && purchaseStatus(p) === "countersigned"}
                    />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {mandate.card ? (
        <section className="grid gap-4" aria-labelledby="signed">
          <h2 id="signed" className="font-semibold text-xl">
            What you signed
          </h2>
          <MandateCard card={mandate.card} />
        </section>
      ) : null}

      {open ? (
        <section className="grid max-w-xl gap-3 rounded-3xl border bg-card p-6">
          <h2 className="font-semibold text-xl">Stop this mandate</h2>
          <p className="text-muted-foreground">
            Your agent can no longer buy with it, and PayPal releases what is still held.
          </p>
          <HoldButton
            hint="Hold for a second to stop the mandate."
            onConfirm={revoke}
            disabled={revoking}
            className="h-11 w-fit rounded-xl border px-5 font-medium text-sm"
          >
            {revoking ? "Stopping" : "Hold to stop"}
          </HoldButton>
        </section>
      ) : null}
    </div>
  );
}
