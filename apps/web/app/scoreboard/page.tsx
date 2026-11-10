import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Eyebrow } from "../../components/notice";
import { ScoreboardPage } from "../../components/scoreboard";

export const metadata: Metadata = {
  title: "Red-team scoreboard",
  description:
    "How often attacks hijack the shopping agent, and how often a cart that breaks the mandate gets past Keelson. Recomputable from the public ledger.",
};

export default function Page() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-10">
      <div className="grid max-w-3xl gap-4">
        <Eyebrow>Continuous red team</Eyebrow>
        <h1 className="text-balance font-semibold text-4xl leading-[1.05] tracking-[-0.03em] sm:text-5xl">
          We attack our own shopping agent. Here is how often it works.
        </h1>
        <p className="max-w-prose text-pretty text-lg text-muted-foreground">
          Prompt injections planted in real store listings try to make the agent buy the wrong
          thing. Every attempt, its cart and Keelson&apos;s decision are written to a hash-chained
          ledger you can download and recompute.{" "}
          <Link href="/scoreboard/methodology/" className="text-foreground underline">
            How it is measured
          </Link>
          .
        </p>
      </div>
      <Suspense>
        <ScoreboardPage />
      </Suspense>
    </div>
  );
}
