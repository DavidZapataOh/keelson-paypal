import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AppShell } from "../../components/app-shell";
import { CheckoutAttacks } from "../../components/checkout-attacks";
import { PageHead } from "../../components/page-head";
import { ScoreboardPage } from "../../components/scoreboard";

export const metadata: Metadata = {
  title: "Red-team scoreboard",
  description:
    "How often attacks hijack the shopping agent, and how often a cart that breaks the mandate gets past Keelson. Recomputable from the public ledger.",
};

export default function Page() {
  return (
    <AppShell>
      <PageHead
        title="Red-team scoreboard"
        line="We attack our own agent. Here is how often it works."
        more={
          <p>
            Prompt injections planted in real store listings try to make the agent buy the wrong
            thing. Every attempt, its cart and Keelson&apos;s decision are written to a hash-chained
            ledger you can download and recompute.{" "}
            <Link href="/scoreboard/methodology/" className="text-foreground underline">
              How it is measured
            </Link>
            .
          </p>
        }
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-12">
        <Suspense>
          <ScoreboardPage />
        </Suspense>
        <CheckoutAttacks />
      </div>
    </AppShell>
  );
}
