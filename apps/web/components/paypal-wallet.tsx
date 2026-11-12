"use client";

import { saveWallet } from "@keelson/paypal/browser";
import { Button } from "@keelson/ui/components/button";
import { Wallet } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, del, get } from "../lib/api";
import { API } from "../lib/config";
import { ErrorNotice } from "./notice";

export interface SavedWallet {
  email: string | null;
  createdAt: string;
}

const saved = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

/** The user's saved PayPal, or `null` when there is none. */
export async function readWallet(): Promise<SavedWallet | null> {
  try {
    return await get<SavedWallet>("/v1/paypal/wallet");
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/**
 * The PayPal saved for holds: save it once in PayPal's own window, see which account it is and
 * remove it, which deletes it at PayPal too.
 */
export function PayPalWallet() {
  const [wallet, setWallet] = useState<SavedWallet | null>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    readWallet()
      .then(setWallet)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not read your PayPal."));
  }, []);
  useEffect(load, [load]);

  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await del("/v1/paypal/wallet");
      setConfirming(false);
      setWallet(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "PayPal was not removed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="grid gap-4 rounded-3xl border bg-card p-5" aria-labelledby="saved-paypal">
      <div className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-bone-2">
          <Wallet className="size-5" aria-hidden="true" />
        </span>
        <h2 id="saved-paypal" className="font-semibold text-xl">
          Saved PayPal
        </h2>
      </div>

      {wallet === undefined ? (
        error ? null : (
          <p role="status" className="sr-only">
            Loading…
          </p>
        )
      ) : wallet ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="mr-auto grid gap-0.5">
            <span className="font-medium">{wallet.email ?? "Your PayPal account"}</span>
            <span className="font-mono text-muted-foreground text-xs">
              Saved {saved.format(new Date(wallet.createdAt))}. Holds need no PayPal window.
            </span>
          </div>
          {confirming ? (
            <div className="flex gap-2">
              <Button disabled={busy} onClick={remove}>
                {busy ? "Removing…" : "Remove PayPal"}
              </Button>
              <Button variant="outline" onClick={() => setConfirming(false)}>
                Keep
              </Button>
            </div>
          ) : (
            <Button variant="outline" onClick={() => setConfirming(true)}>
              Remove
            </Button>
          )}
        </div>
      ) : (
        <SaveButton onSaved={setWallet} />
      )}
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
    </section>
  );
}

function SaveButton({ onSaved }: { onSaved: (wallet: SavedWallet) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "ineligible" | "cancelled">("loading");
  const [error, setError] = useState<string>();
  const done = useRef(onSaved);
  done.current = onSaved;

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    saveWallet({
      api: API,
      container: el,
      onSaved: (w) => done.current(w),
      onCancel: () => setState("cancelled"),
      onError: (e) => setError(e instanceof Error ? e.message : "PayPal could not finish."),
    })
      .then(setState)
      .catch(() => setError("PayPal is not available right now."));
    return () => el.replaceChildren();
  }, []);

  return (
    <div className="grid gap-3">
      <p className="text-pretty">Save PayPal once and your holds need no PayPal window.</p>
      <p className="text-pretty text-muted-foreground text-sm">
        PayPal shows you what you agree to: Keelson holds money only under mandates you sign. Remove
        it here or on paypal.com at any time.
      </p>
      <div ref={container} className="min-h-12 max-w-sm" />
      {state === "cancelled" ? (
        <p className="text-muted-foreground text-sm" role="status">
          You closed PayPal. Nothing was saved.
        </p>
      ) : null}
      {state === "ineligible" ? (
        <ErrorNotice>PayPal can't be saved in this browser.</ErrorNotice>
      ) : null}
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
    </div>
  );
}
