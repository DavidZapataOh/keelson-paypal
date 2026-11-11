import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { LivePurchases } from "../../components/live-purchases";
import { PageHead } from "../../components/page-head";

export const metadata: Metadata = {
  title: "Live purchases",
  description:
    "Purchases the shopping agent made with real money at real stores through PayPal, and the carts Keelson blocked there, each with a public Alibi you can verify.",
};

export default function Page() {
  return (
    <AppShell>
      <PageHead
        title="Live purchases"
        line="Real stores, real money. Each one with a public Alibi."
        more={
          <p>
            The agent works under a signed mandate at a store that accepts PayPal and does not
            integrate Keelson. Its click on the final PayPal payment waits for Keelson's
            countersignature of the cart, and only on the store the mandate names. A cart that
            breaks the mandate is blocked before that click and nothing is charged. Keelson does not
            cover these purchases, and no dispute is ever opened against these stores.
          </p>
        }
      />
      <LivePurchases />
    </AppShell>
  );
}
