"use client";

import { Button } from "@keelson/ui/components/button";
import { BellRing, Loader2, Share, Smartphone } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { post } from "../lib/api";
import { disablePush, enablePush, type PushState, pushState } from "../lib/push";
import { ErrorNotice } from "./notice";

const IOS_NOTE =
  "On iPhone or iPad, add Keelson to your Home Screen first (iOS 16.4 or later): tap Share, then Add to Home Screen, and open Keelson from there.";

function usePush() {
  const [state, setState] = useState<PushState>();
  useEffect(() => {
    pushState().then(setState, () => setState("unsupported"));
  }, []);
  return [state, setState] as const;
}

const failure = (e: unknown) =>
  e instanceof Error ? e.message : "Phone approvals could not be turned on. Try again.";

/** Phone approvals on this device: turn them on, send a test, turn them off. */
export function PhoneApprovals() {
  const [state, setState] = usePush();
  const [busy, setBusy] = useState<"on" | "test" | "off">();
  const [sent, setSent] = useState<number>();
  const [error, setError] = useState<string>();

  const run = async (kind: "on" | "test" | "off", act: () => Promise<void>) => {
    setBusy(kind);
    setError(undefined);
    setSent(undefined);
    try {
      await act();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section
      aria-labelledby="phone-approvals"
      className="grid gap-4 rounded-3xl border bg-card p-5 sm:p-6"
    >
      <div className="flex items-start gap-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-bone-2">
          <Smartphone className="size-5" aria-hidden="true" />
        </span>
        <div className="grid min-w-0 flex-1 gap-1">
          <h2
            id="phone-approvals"
            className="flex flex-wrap items-center gap-2 font-semibold text-lg"
          >
            Phone approvals
            {state === "on" ? (
              <span className="rounded-full bg-ok px-2 py-0.5 font-normal text-bone text-xs">
                On for this device
              </span>
            ) : null}
          </h2>
          <p className="text-pretty text-muted-foreground">
            When an agent needs your approval, Keelson blocks a cart or you stop your agents, this
            device gets a notification. Tap it to answer with your passkey.
          </p>
        </div>
      </div>

      {state === undefined ? (
        <p role="status" className="sr-only">
          Checking this device
        </p>
      ) : state === "install" ? (
        <p className="flex gap-3 rounded-2xl bg-bone-2 px-4 py-3.5 text-sm leading-relaxed">
          <Share className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {IOS_NOTE}
        </p>
      ) : state === "unsupported" ? (
        <p className="rounded-2xl bg-bone-2 px-4 py-3.5 text-sm leading-relaxed">
          This browser can't show notifications. Open Keelson in Chrome, Edge, Firefox or Safari
          16.4 or later.
        </p>
      ) : state === "denied" ? (
        <p className="rounded-2xl bg-bone-2 px-4 py-3.5 text-sm leading-relaxed">
          Notifications are blocked for this site. Allow them in your browser's site settings, then
          reload this page.
        </p>
      ) : (
        <div className="grid gap-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            {state === "off" ? (
              <Button
                size="lg"
                className="h-12 rounded-xl"
                disabled={busy !== undefined}
                onClick={() => run("on", async () => setState(await enablePush()))}
              >
                {busy === "on" ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <BellRing aria-hidden="true" />
                )}
                Turn on phone approvals
              </Button>
            ) : (
              <>
                <Button
                  size="lg"
                  className="h-12 rounded-xl"
                  disabled={busy !== undefined}
                  onClick={() =>
                    run("test", async () => {
                      setSent((await post<{ sent: number }>("/v1/push/test")).sent);
                    })
                  }
                >
                  {busy === "test" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                  Send a test notification
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="h-12 rounded-xl"
                  disabled={busy !== undefined}
                  onClick={() => run("off", async () => setState(await disablePush()))}
                >
                  Turn off on this device
                </Button>
              </>
            )}
          </div>
          <p role="status" className="text-muted-foreground text-sm">
            {sent === undefined
              ? ""
              : sent > 0
                ? "Sent. It should arrive within a few seconds."
                : "No device accepted it. Turn phone approvals off and on again."}
          </p>
          <p className="text-muted-foreground text-sm">{IOS_NOTE}</p>
        </div>
      )}
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
    </section>
  );
}

/**
 * A short offer of phone approvals where the user waits on agents, shown only while this device
 * could get them and does not.
 */
export function PhoneApprovalsOffer() {
  const [state, setState] = usePush();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (state !== "off" && state !== "install") return null;
  return (
    <aside
      aria-label="Phone approvals"
      className="grid gap-3 rounded-2xl border bg-card px-4 py-3.5 sm:grid-cols-[auto_1fr_auto] sm:items-center"
    >
      <BellRing className="hidden size-5 sm:block" aria-hidden="true" />
      <p className="text-pretty text-sm leading-snug">
        <span className="font-medium">Answer agents from your phone.</span>{" "}
        <span className="text-muted-foreground">
          {state === "install"
            ? "On iPhone, add Keelson to your Home Screen first (iOS 16.4+), then turn it on in Alerts."
            : "Get a notification when an agent needs you, instead of watching this page."}
        </span>
      </p>
      {state === "install" ? (
        <Button asChild variant="outline" className="rounded-xl">
          <Link href="/alerts/">How to</Link>
        </Button>
      ) : (
        <Button
          variant="outline"
          className="rounded-xl"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              setState(await enablePush());
            } catch (e) {
              setError(failure(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Turn on
        </Button>
      )}
      {error ? (
        <p role="alert" className="text-sm sm:col-span-3">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
