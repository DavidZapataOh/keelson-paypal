import type { Metadata } from "next";
import { LivePurchases } from "../../components/live-purchases";

export const metadata: Metadata = {
  title: "Live purchases",
  description:
    "Purchases the shopping agent made with real money at real stores through PayPal, and the carts Keelson blocked there, each with a public Alibi you can verify.",
};

export default function Page() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-10">
      <div className="grid max-w-3xl gap-4">
        <h1 className="text-balance font-semibold text-4xl leading-[1.05] tracking-[-0.03em] sm:text-5xl">
          The same agent, buying at real stores with real money.
        </h1>
        <p className="max-w-prose text-pretty text-lg text-muted-foreground">
          The agent works under a signed mandate at a store that accepts PayPal and does not
          integrate Keelson. Its click on the final PayPal payment waits for Keelson's
          countersignature of the checkout's total, tax and shipping included, and only on the store
          the mandate names. A cart that breaks the mandate is blocked before that click and nothing
          is charged. Every entry has a public Alibi. Keelson does not cover these purchases, and no
          dispute is ever opened against these stores.
        </p>
      </div>
      <LivePurchases />
    </div>
  );
}
