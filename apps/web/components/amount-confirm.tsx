"use client";

import { type PasskeyRef, signMandate } from "@keelson/mandate/browser";
import { Amount } from "@keelson/ui/components/amount";
import { Button } from "@keelson/ui/components/button";
import { Check, Fingerprint, Loader2, X } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { get, post } from "../lib/api";
import { major } from "../lib/format";
import { AppShell } from "./app-shell";
import { ErrorNotice } from "./notice";

/** The amount the user is asked to confirm, as `GET /v1/purchases/{id}/amount-confirmation` serves it. */
interface Confirmation {
  purchaseId: string;
  store: string;
  payee: string;
  total: { currency: string; minor: string };
  state: "PENDING" | "CONFIRMED" | "DECLINED" | "EXPIRED";
  expiresAt: string;
  challenge: string;
  credentialId: string;
  spc: { payeeName: string; payeeOrigin: string; total: { currency: string; value: string } };
}

const host = (origin: string) => URL.parse(origin)?.hostname.replace(/^www\./, "") ?? origin;

const fromBase64Url = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

function useSecondsLeft(until: string | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return until === undefined
    ? undefined
    : Math.max(0, Math.floor((Date.parse(until) - now) / 1000));
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function Confirm() {
  const id = useSearchParams().get("id") ?? "";
  const [c, setC] = useState<Confirmation>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<"confirm" | "decline">();
  const left = useSecondsLeft(c?.expiresAt);

  const load = useCallback(
    () =>
      get<Confirmation>(`/v1/purchases/${encodeURIComponent(id)}/amount-confirmation`).then(
        setC,
        (e: Error) => setError(e.message),
      ),
    [id],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (error && !c) return <ErrorNotice>{error}</ErrorNotice>;
  if (!c)
    return (
      <p role="status" className="sr-only">
        Loading…
      </p>
    );

  const expired = c.state === "EXPIRED" || (c.state === "PENDING" && left === 0);
  const answer = async (kind: "confirm" | "decline") => {
    setBusy(kind);
    setError(undefined);
    try {
      let body: unknown = { decline: true };
      if (kind === "confirm") {
        const { passkeys } = await get<{ passkeys: PasskeyRef[] }>("/v1/passkeys");
        const signer = passkeys.filter((p) => p.credentialId === c.credentialId);
        if (signer.length === 0) {
          throw new Error(
            "Use the passkey you signed this mandate with, on the device that has it.",
          );
        }
        body = {
          assertion: await signMandate(fromBase64Url(c.challenge), signer, {
            spc: c.spc,
            onDevice: [c.credentialId],
          }),
        };
      }
      setC(
        await post<Confirmation>(
          `/v1/purchases/${encodeURIComponent(id)}/amount-confirmation`,
          body,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not go through. Try again.");
    } finally {
      setBusy(undefined);
    }
  };

  const store = host(c.store);
  const amount = (
    <Amount
      value={major(c.total.minor, c.total.currency)}
      currency={c.total.currency}
      className="text-[3.25rem]"
    />
  );

  if (c.state === "CONFIRMED" || c.state === "DECLINED") {
    const ok = c.state === "CONFIRMED";
    return (
      <section className="mx-auto grid w-full max-w-md justify-items-center gap-5 py-10 text-center">
        <span
          className={`grid size-16 place-items-center rounded-full ${ok ? "bg-ok text-bone" : "bg-vermilion text-graphite"}`}
        >
          {ok ? (
            <Check className="size-8" aria-hidden="true" />
          ) : (
            <X className="size-8" aria-hidden="true" />
          )}
        </span>
        <h1 className="text-pretty font-semibold text-2xl">
          {ok ? "Confirmed. Your agent pays now." : "Declined. Nothing is paid."}
        </h1>
        <p className="text-muted-foreground">
          {amount} at {store}
        </p>
        <Button asChild variant="outline" className="rounded-xl">
          <Link href="/">Home</Link>
        </Button>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="confirm-amount"
      className="mx-auto grid w-full max-w-md gap-6 rounded-3xl border bg-card p-6 sm:p-8"
    >
      <div className="grid gap-1">
        <p className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.14em]">
          PayPal checkout · {store}
        </p>
        <h1 id="confirm-amount" className="font-semibold text-xl">
          Confirm the amount
        </h1>
      </div>
      <div className="grid gap-2">
        {amount}
        <p className="text-pretty text-muted-foreground text-sm">
          Your agent is about to pay <span className="text-foreground">{store}</span> with PayPal.
          Keelson could not confirm this amount with PayPal for this store, so you do.
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">PayPal payee</dt>
        <dd className="font-mono">{c.payee}</dd>
        <dt className="text-muted-foreground">Time left</dt>
        <dd className="tabular-nums">
          {expired ? "Expired" : left === undefined ? "" : clock(left)}
        </dd>
      </dl>
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
      {expired ? (
        <p className="rounded-2xl bg-bone-2 px-4 py-3 text-sm">
          Your agent stopped waiting. Nothing was paid.
        </p>
      ) : (
        <div className="grid gap-2">
          <Button
            size="lg"
            className="rounded-xl"
            disabled={busy !== undefined}
            onClick={() => void answer("confirm")}
          >
            {busy === "confirm" ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Fingerprint aria-hidden="true" />
            )}
            Confirm with passkey
          </Button>
          <Button
            size="lg"
            variant="ghost"
            className="rounded-xl"
            disabled={busy !== undefined}
            onClick={() => void answer("decline")}
          >
            {busy === "decline" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            Not this amount
          </Button>
        </div>
      )}
    </section>
  );
}

/** The phone approval a push opens when only the user can confirm what their agent pays. */
export function AmountConfirmPage() {
  return (
    <AppShell>
      <Confirm />
    </AppShell>
  );
}
