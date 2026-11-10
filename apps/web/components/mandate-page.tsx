"use client";

import { Button } from "@keelson/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader } from "@keelson/ui/components/empty";
import { Status } from "@keelson/ui/components/status";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { post } from "../lib/api";
import { money, when } from "../lib/format";
import { mandateLabel, purchaseStatus } from "../lib/status";
import { useMandate } from "../lib/use-mandate";
import { MandateCard } from "./mandate-card";
import { ErrorNotice, Eyebrow } from "./notice";
import { PayPalHold } from "./paypal-hold";

export function MandatePage() {
  const id = useSearchParams().get("id");
  const { mandate, error, pending, reload, signedIn, sessionPending } = useMandate(id);
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
  const spent = BigInt(budget.maxMinor) - BigInt(budget.remainingMinor);
  const share = Number((spent * 1000n) / (BigInt(budget.maxMinor) || 1n)) / 10;
  const needsHold =
    (mandate.state === "SIGNED" || mandate.state === "HOLD_PENDING") &&
    mandate.hold?.mode !== "per_purchase";
  const open =
    mandate.state === "SIGNED" || mandate.state === "HOLD_PENDING" || mandate.state === "ACTIVE";

  const revoke = async () => {
    setRevoking(true);
    await post(`/v1/mandates/${mandate.id}/revoke`).catch(() => {});
    setRevoking(false);
    reload();
  };

  return (
    <div className="grid gap-12">
      <section className="grid gap-6" aria-labelledby="budget">
        <Eyebrow>
          Mandate {mandate.id.slice(-8)} · {mandateLabel(mandate.state)}
        </Eyebrow>
        <h1 id="budget" className="text-amount font-semibold tracking-[-0.035em]">
          {money(budget.remainingMinor, budget.currency)}
          <span className="font-normal text-muted-foreground text-xl tracking-normal">
            {" "}
            left of {money(budget.maxMinor, budget.currency)}
          </span>
        </h1>
        <div
          className="h-1.5 w-full max-w-md overflow-hidden rounded-full bg-border"
          aria-hidden="true"
        >
          <div className="h-full bg-foreground" style={{ width: `${share}%` }} />
        </div>
        <p className="text-muted-foreground text-sm">Valid until {when(mandate.expiresAt)}</p>
      </section>

      {needsHold ? (
        <section className="grid max-w-xl gap-4 rounded-xl border p-6" aria-labelledby="hold">
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
        <section key={p.requestId} className="grid max-w-xl gap-4 rounded-xl border p-6">
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
          <ul className="grid divide-y rounded-xl border">
            {mandate.purchases.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/purchase/?mandate=${mandate.id}&id=${p.id}`}
                  className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 px-5 py-4 hover:bg-accent/60"
                >
                  <span className="font-medium">{p.merchantId}</span>
                  <span className="tnum text-right font-mono">
                    {money(p.amount.minor, p.amount.currency)}
                  </span>
                  <span className="text-muted-foreground text-sm">{when(p.createdAt)}</span>
                  <span className="justify-self-end">
                    <Status state={purchaseStatus(p)} appearance="inline" />
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
        <section className="grid max-w-xl gap-3">
          <h2 className="font-semibold text-xl">Stop this mandate</h2>
          <p className="text-muted-foreground">
            Your agent can no longer buy with it, and PayPal releases what is still held.
          </p>
          <Button variant="outline" onClick={revoke} disabled={revoking} className="w-fit">
            {revoking ? "Revoking…" : "Revoke mandate"}
          </Button>
        </section>
      ) : null}
    </div>
  );
}
