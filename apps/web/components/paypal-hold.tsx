"use client";

import {
  approveHold,
  holdWithSavedPayPal,
  mandateHold,
  purchaseHold,
} from "@keelson/paypal/browser";
import { Button } from "@keelson/ui/components/button";
import { useEffect, useRef, useState } from "react";
import { API } from "../lib/config";
import { ErrorNotice } from "./notice";
import { readWallet, type SavedWallet } from "./paypal-wallet";

type Target = { mandateId: string } & (
  | { kind: "mandate" }
  | { kind: "purchase"; requestId: string; orderId: string }
);

/**
 * Holds a mandate's budget: with the user's saved PayPal when there is one, in one tap and no
 * PayPal window, otherwise with the PayPal button of {@link PayPalButtonHold}.
 */
export function PayPalHold(props: { target: Target; currency: string; onAuthorized: () => void }) {
  const { target, onAuthorized } = props;
  const [wallet, setWallet] = useState<SavedWallet | null>();
  const [holding, setHolding] = useState(false);
  const [error, setError] = useState<string>();
  const mandate = target.kind === "mandate";

  useEffect(() => {
    if (!mandate) return;
    readWallet()
      .then(setWallet)
      .catch(() => setWallet(null));
  }, [mandate]);

  if (!mandate || wallet === null) return <PayPalButtonHold {...props} />;
  if (wallet === undefined) {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        Loading PayPal…
      </p>
    );
  }

  const hold = async () => {
    setHolding(true);
    setError(undefined);
    try {
      const done = await holdWithSavedPayPal(API, target.mandateId);
      // PayPal asks the buyer this time: the PayPal button offers the same order.
      if (done === "approve") setWallet(null);
      else onAuthorized();
    } catch (e) {
      setError(e instanceof Error ? e.message : "PayPal could not hold it.");
    } finally {
      setHolding(false);
    }
  };

  return (
    <div className="grid gap-3">
      <Button
        size="lg"
        className="h-13 rounded-xl text-base sm:w-fit"
        disabled={holding}
        onClick={hold}
      >
        {holding ? "Holding…" : `Hold with ${wallet.email ?? "your saved PayPal"}`}
      </Button>
      <p className="text-muted-foreground text-sm">Your saved PayPal. No PayPal window opens.</p>
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
    </div>
  );
}

/**
 * The PayPal button that approves a hold: the mandate's budget, or one purchase of a mandate that
 * allows several stores. Keelson creates the order; PayPal only shows it to the buyer.
 */
function PayPalButtonHold({
  target,
  currency,
  onAuthorized,
}: {
  target: Target;
  currency: string;
  onAuthorized: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "ineligible" | "cancelled">("loading");
  const [error, setError] = useState<string>();
  const done = useRef(onAuthorized);
  done.current = onAuthorized;
  const key = target.kind === "mandate" ? target.mandateId : target.requestId;

  // biome-ignore lint/correctness/useExhaustiveDependencies: one button per hold, keyed by `key`
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const calls =
      target.kind === "mandate"
        ? mandateHold(API, target.mandateId)
        : purchaseHold(API, target.mandateId, target.requestId, target.orderId);
    approveHold({
      api: API,
      container: el,
      currencyCode: currency,
      createOrder: calls.createOrder,
      authorize: async (orderId) => {
        await calls.authorize(orderId);
        done.current();
      },
      onCancel: () => setState("cancelled"),
      onError: (e) => setError(e instanceof Error ? e.message : "PayPal could not finish."),
    })
      .then(setState)
      .catch((e: Error) => setError(e.message));
    return () => el.replaceChildren();
  }, [key, currency]);

  return (
    <div className="grid gap-3">
      <div ref={container} className="min-h-12 max-w-sm" />
      {state === "loading" ? (
        <p className="text-muted-foreground text-sm" role="status">
          Loading PayPal…
        </p>
      ) : null}
      {state === "cancelled" ? (
        <p className="text-muted-foreground text-sm" role="status">
          You closed PayPal. Nothing was held; the same order is ready when you are.
        </p>
      ) : null}
      {state === "ineligible" ? (
        <ErrorNotice>PayPal is not available in this browser for {currency}.</ErrorNotice>
      ) : null}
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
    </div>
  );
}
