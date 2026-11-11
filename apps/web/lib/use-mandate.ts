"use client";

import { useCallback, useEffect, useState } from "react";
import { get } from "./api";
import { authClient } from "./auth";
import { useEvents, userChannel } from "./events";
import type { MandateView } from "./types";

/**
 * The signed-in user's mandate `id`, kept current: every event on its channel (hold, purchase
 * holds, purchases) re-reads it, so what is shown, the purchases waiting for approval included,
 * is always what the API holds.
 */
export function useMandate(id: string | null) {
  const session = authClient.useSession();
  const [mandate, setMandate] = useState<MandateView>();
  const [error, setError] = useState<string>();
  // Purchases countersigned while the page was open: the one moment the app animates.
  const [countersigned, setCountersigned] = useState<ReadonlySet<string>>(new Set());
  // The live view of the agent's browser while it shops under this mandate.
  const [liveView, setLiveView] = useState<string>();

  const load = useCallback(async () => {
    if (!id) return;
    await get<MandateView>(`/v1/mandates/${encodeURIComponent(id)}`)
      .then((m) => {
        setMandate(m);
        setError(undefined);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  useEffect(() => {
    if (session.data) void load();
  }, [session.data, load]);

  const onEvent = useCallback(
    (e: { type: string } & Record<string, unknown>) => {
      if (e.type === "agent.run") {
        setLiveView(
          e.state === "started" && typeof e.liveViewUrl === "string" ? e.liveViewUrl : undefined,
        );
        return;
      }
      if (e.type === "purchase.countersigned" && typeof e.purchaseId === "string") {
        const id = e.purchaseId;
        setCountersigned((all) => new Set(all).add(id));
      }
      void load();
    },
    [load],
  );
  const userId = session.data?.user.id;
  useEvents(userId && id ? userChannel(userId, `mandate:${id}`) : undefined, onEvent, load);

  return {
    mandate,
    error,
    pending: mandate?.pendingHolds ?? [],
    countersigned,
    liveView,
    reload: load,
    signedIn: session.data !== null,
    sessionPending: session.isPending,
  };
}
