import type { Metadata } from "next";
import { LivePurchases } from "../../components/live-purchases";
import { Eyebrow } from "../../components/notice";

export const metadata: Metadata = {
  title: "Live purchases",
  description:
    "Purchases the shopping agent made with real money at real stores through PayPal, each with a public Alibi you can verify.",
};

export default function Page() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-10">
      <div className="grid max-w-3xl gap-4">
        <Eyebrow>Live purchases</Eyebrow>
        <h1 className="text-balance font-semibold text-4xl leading-[1.05] tracking-[-0.03em] sm:text-5xl">
          The same agent, buying at real stores with real money.
        </h1>
        <p className="max-w-prose text-pretty text-lg text-muted-foreground">
          The agent works under a signed mandate at a store that accepts PayPal and does not
          integrate Keelson. Its click on the final PayPal payment waits for Keelson's
          countersignature of the cart. Each purchase has a public Alibi with the PayPal transaction
          the store was paid by. Keelson does not cover these purchases, and no dispute is ever
          opened against these stores.
        </p>
      </div>
      <LivePurchases />
    </div>
  );
}
