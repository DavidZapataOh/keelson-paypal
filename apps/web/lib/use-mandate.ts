"use client";

import { useCallback, useEffect, useState } from "react";
import { get } from "./api";
import { authClient } from "./auth";
import { useEvents, userChannel } from "./events";
import type { MandateView } from "./types";

/** A purchase of a several-store mandate waiting for the buyer's PayPal approval. */
export interface PendingHold {
  requestId: string;
  orderId: string;
  merchant: string;
  amountMinor: string;
}

/**
 * The signed-in user's mandate `id`, kept current: every event on its channel (hold, purchase
 * holds, purchases) re-reads it, so what is shown is always what the API holds.
 */
export function useMandate(id: string | null) {
  const session = authClient.useSession();
  const [mandate, setMandate] = useState<MandateView>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<PendingHold[]>([]);
  // Purchases countersigned while the page was open: the one moment the app animates.
  const [countersigned, setCountersigned] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(() => {
    if (!id) return;
    get<MandateView>(`/v1/mandates/${encodeURIComponent(id)}`)
      .then((m) => {
        setMandate(m);
        setError(undefined);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  useEffect(() => {
    if (session.data) load();
  }, [session.data, load]);

  const onEvent = useCallback(
    (e: { type: string } & Record<string, unknown>) => {
      if (e.type === "mandate.purchase_hold") {
        const hold = e as unknown as PendingHold & { state: string };
        setPending((all) =>
          hold.state === "PENDING"
            ? [...all.filter((p) => p.requestId !== hold.requestId), hold]
            : all.filter((p) => p.requestId !== hold.requestId),
        );
      }
      if (e.type === "purchase.countersigned" && typeof e.purchaseId === "string") {
        const id = e.purchaseId;
        setCountersigned((all) => new Set(all).add(id));
      }
      load();
    },
    [load],
  );
  const userId = session.data?.user.id;
  useEvents(userId && id ? userChannel(userId, `mandate:${id}`) : undefined, onEvent, load);

  return {
    mandate,
    error,
    pending,
    countersigned,
    reload: load,
    signedIn: session.data !== null,
    sessionPending: session.isPending,
  };
}
