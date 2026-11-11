"use client";

import { Button } from "@keelson/ui/components/button";
import Link from "next/link";
import { money } from "../../lib/format";
import type { MandateView } from "../../lib/types";
import { useMandate } from "../../lib/use-mandate";
import { RiveMoment } from "../brand";
import { MandateVisual } from "../mandate-visual";
import { ErrorNotice } from "../notice";
import { PayPalHold } from "../paypal-hold";
import { OnboardingFrame } from "./frame";

const short = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(
    new Date(iso),
  );

function Card({ mandate, state }: { mandate: MandateView; state: string }) {
  const row = (f: string) => mandate.card?.rows.find((r) => r.field === f)?.values;
  return (
    <MandateVisual
      amount={Number(mandate.budget.maxMinor) / 100}
      currency={mandate.budget.currency}
      amountLabel="Up to"
      what={row("items")?.join(", ") ?? row("summary")?.[0] ?? ""}
      chips={(row("merchant") ?? ["Any store"]).map((m) => m.split(" (")[0] ?? m)}
      until={short(mandate.expiresAt)}
      state={state}
      seal="closed"
    />
  );
}

/**
 * The last steps of the first mandate: PayPal holds the cap, then the agent is live. Each event on
 * the mandate's channel re-reads it, so a hold approved elsewhere moves this on too.
 */
export function GoLive({ id }: { id: string }) {
  const { mandate, error, reload } = useMandate(id);
  if (error) {
    return (
      <div className="mx-auto max-w-xl px-5 py-12">
        <ErrorNotice>{error}</ErrorNotice>
      </div>
    );
  }
  if (!mandate) {
    return (
      <p role="status" className="sr-only">
        Loading
      </p>
    );
  }

  const cap = money(mandate.budget.maxMinor, mandate.budget.currency);
  const live = mandate.state === "ACTIVE";

  if (!live) {
    return (
      <OnboardingFrame
        step="Sign"
        stageLabel="Your signed mandate"
        stage={
          <div className="w-full max-w-[420px]">
            <Card mandate={mandate} state="Signed" />
          </div>
        }
        action={
          <PayPalHold
            target={{ kind: "mandate", mandateId: mandate.id }}
            currency={mandate.budget.currency}
            onAuthorized={reload}
          />
        }
      >
        <h1 className="text-balance font-semibold text-[1.75rem] leading-[1.1] tracking-[-0.025em] sm:text-[2rem]">
          Hold {cap} on PayPal
        </h1>
        <p className="mt-3 text-pretty text-lg text-muted-foreground leading-snug">
          Only what your agent buys is charged. The rest goes back.
        </p>
      </OnboardingFrame>
    );
  }

  return (
    <OnboardingFrame
      step="Agent"
      complete
      stageLabel="Your mandate is live"
      stage={
        <div className="grid w-full max-w-[420px] justify-items-center gap-2">
          <RiveMoment
            artboard="Live"
            play
            className="size-40"
            still={<span className="size-3 rounded-full bg-vermilion" />}
          />
          <Card mandate={mandate} state="Live" />
        </div>
      }
      action={
        <div className="grid grid-cols-2 gap-2">
          <Button asChild size="lg" variant="outline" className="h-13 rounded-xl">
            <Link href={`/mandate/?id=${mandate.id}`}>What you signed</Link>
          </Button>
          <Button asChild size="lg" className="h-13 rounded-xl text-base">
            <Link href="/">Go home</Link>
          </Button>
        </div>
      }
    >
      <h1 className="text-balance font-semibold text-[1.75rem] leading-[1.1] tracking-[-0.025em] sm:text-[2rem]">
        Your agent is live
      </h1>
      <p className="mt-3 text-pretty text-lg text-muted-foreground leading-snug">
        Every cart it tries shows up on your home.
      </p>
    </OnboardingFrame>
  );
}
