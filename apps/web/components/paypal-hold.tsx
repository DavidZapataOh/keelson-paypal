"use client";

import { approveHold, mandateHold, purchaseHold } from "@keelson/paypal/browser";
import { useEffect, useRef, useState } from "react";
import { API } from "../lib/config";
import { ErrorNotice } from "./notice";

type Target = { mandateId: string } & (
  | { kind: "mandate" }
  | { kind: "purchase"; requestId: string; orderId: string }
);

/**
 * The PayPal button that approves a hold: the mandate's budget, or one purchase of a mandate that
 * allows several stores. Keelson creates the order; PayPal only shows it to the buyer.
 */
export function PayPalHold({
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
