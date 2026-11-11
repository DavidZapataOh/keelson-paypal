"use client";

import { Button } from "@keelson/ui/components/button";
import { Check, Loader2, Mail } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { ApiError, post } from "../lib/api";
import { ErrorNotice } from "./notice";

const COPY = {
  confirm: {
    title: "Confirm your email for alerts",
    line: "Keelson will email this address when an agent needs you, when it blocks a cart, when a purchase is paid and when you stop your agents.",
    action: "Confirm this address",
    done: (address?: string) => `${address ?? "Your address"} is confirmed. Alerts go there now.`,
    path: "/v1/alerts/email/confirm",
  },
  unsubscribe: {
    title: "Stop email alerts",
    line: "Keelson will stop emailing this address. Phone approvals and your activity in the app stay as they are.",
    action: "Unsubscribe",
    done: () => "Unsubscribed. Keelson won't email this address again.",
    path: "/v1/alerts/unsubscribe",
  },
} as const;

/**
 * Opened from an email: confirms the address or unsubscribes it on the user's click, never on
 * load, so a mail scanner that follows links changes nothing.
 */
export function AlertLinkPage({ kind }: { kind: keyof typeof COPY }) {
  const token = useSearchParams().get("token") ?? "";
  const copy = COPY[kind];
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const [error, setError] = useState<string>();

  const act = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const out =
        kind === "confirm"
          ? await post<{ address: string }>(copy.path, { token })
          : await post<{ unsubscribed: true }>(`${copy.path}?token=${encodeURIComponent(token)}`);
      setDone(copy.done("address" in out ? out.address : undefined));
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 404
          ? "This link is not valid any more: it was used, replaced by a newer one or expired. Set your address again in Alerts."
          : e instanceof Error
            ? e.message
            : "It did not work. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main id="main" className="grid min-h-dvh place-items-center px-5 py-12">
      <div className="grid w-full max-w-md gap-6">
        <Link href="/" className="w-fit rounded-sm" aria-label="Keelson, home">
          {/* biome-ignore lint/performance/noImgElement: a static export serves the SVG as is */}
          <img src="/keelson.svg" alt="" width={94} height={28} className="h-7 w-auto" />
        </Link>
        <section className="grid gap-5 rounded-3xl border bg-card p-6 sm:p-8">
          <span
            className={`grid size-12 place-items-center rounded-2xl ${done ? "bg-ok text-bone" : "bg-bone-2"}`}
          >
            {done ? (
              <Check className="size-6" strokeWidth={2.5} aria-hidden="true" />
            ) : (
              <Mail className="size-6" aria-hidden="true" />
            )}
          </span>
          <div className="grid gap-2">
            <h1 className="text-balance font-semibold text-[1.75rem] leading-[1.1] tracking-[-0.025em]">
              {done ? (kind === "confirm" ? "Confirmed" : "Unsubscribed") : copy.title}
            </h1>
            <p role="status" className="text-pretty text-muted-foreground leading-snug">
              {done ?? copy.line}
            </p>
          </div>
          {done ? (
            <Button asChild size="lg" variant="outline" className="h-12 rounded-xl">
              <Link href="/alerts/">Open Alerts</Link>
            </Button>
          ) : (
            <Button size="lg" className="h-12 rounded-xl" disabled={busy || !token} onClick={act}>
              {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {copy.action}
            </Button>
          )}
          {error ? <ErrorNotice>{error}</ErrorNotice> : null}
        </section>
      </div>
    </main>
  );
}
