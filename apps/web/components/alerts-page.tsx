"use client";

import { Button } from "@keelson/ui/components/button";
import { Skeleton } from "@keelson/ui/components/skeleton";
import { Loader2, Mail } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { ApiError, del, get, put } from "../lib/api";
import { when } from "../lib/format";
import { AppShell } from "./app-shell";
import { ErrorNotice } from "./notice";
import { PageHead } from "./page-head";
import { PhoneApprovals } from "./phone-approvals";

interface AlertEmail {
  address: string | null;
  confirmed: boolean;
}

interface SentEmail {
  id: string;
  address: string;
  event: string;
  subject: string;
  logIndex: string | null;
  alibiUrl: string | null;
  sentAt: string | null;
  error: string | null;
  createdAt: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

/** The address alerts go to: never the sign-in address unless typed here and confirmed. */
function EmailAlerts({ onChange }: { onChange: () => void }) {
  const [email, setEmail] = useState<AlertEmail>();
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const id = useId();

  const load = useCallback(() => {
    get<AlertEmail>("/v1/alerts/email").then(setEmail, (e) => setError(message(e)));
  }, []);
  useEffect(load, [load]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      setEmail(await put<AlertEmail>("/v1/alerts/email", { address: address.trim() }));
      setAddress("");
      onChange();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? "A link was just sent. Wait a minute before sending another."
          : message(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await del("/v1/alerts/email");
      setEmail({ address: null, confirmed: false });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="email-alerts"
      className="grid gap-4 rounded-3xl border bg-card p-5 sm:p-6"
    >
      <div className="flex items-start gap-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-bone-2">
          <Mail className="size-5" aria-hidden="true" />
        </span>
        <div className="grid min-w-0 flex-1 gap-1">
          <h2 id="email-alerts" className="font-semibold text-lg">
            Email for alerts
          </h2>
          <p className="text-pretty text-muted-foreground">
            A copy of every alert, and a record of each purchase with its Alibi. Only what your
            agents did; never marketing. Keelson never emails your sign-in address unless you enter
            it here.
          </p>
        </div>
      </div>

      {email === undefined ? (
        <Skeleton className="h-12 rounded-xl" />
      ) : email.address ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl bg-bone-2 px-4 py-3">
          <div className="mr-auto grid min-w-0 gap-0.5">
            <span className="truncate font-medium">{email.address}</span>
            <span className={`text-sm ${email.confirmed ? "text-ok" : "text-warn"}`}>
              {email.confirmed
                ? "Confirmed. Alerts go here."
                : "Waiting for you to open the link we sent. Nothing is emailed until then."}
            </span>
          </div>
          <Button variant="outline" className="rounded-xl" disabled={busy} onClick={remove}>
            Stop emails
          </Button>
        </div>
      ) : null}

      <form onSubmit={save} className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <label htmlFor={id} className="sr-only">
          Email address for alerts
        </label>
        <input
          id={id}
          type="email"
          required
          autoComplete="email"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={email?.address ? "Use another address" : "you@example.com"}
          className="h-12 rounded-xl border bg-card px-4 outline-none placeholder:text-muted-foreground focus-visible:border-foreground focus-visible:ring-4 focus-visible:ring-foreground/8"
        />
        <Button
          type="submit"
          size="lg"
          disabled={busy || !address.trim()}
          className="h-12 rounded-xl"
        >
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Send confirmation link
        </Button>
      </form>
      <p className="text-muted-foreground text-sm">
        The link works once, for 24 hours. Every email has a one-click unsubscribe.
      </p>
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
    </section>
  );
}

const EVENTS: Record<string, string> = {
  "email.confirm": "Confirmation",
  "approval.requested": "Approval",
  "change.requested": "Change",
  "connection.requested": "Connection",
  "purchase.blocked": "Blocked",
  "purchase.captured": "Paid",
  "agents.stopped": "Stop",
};

/** Every email Keelson composed for the user, with what it reported. */
function Trail({ emails }: { emails: SentEmail[] | undefined }) {
  return (
    <section aria-labelledby="sent" className="grid gap-3 rounded-3xl border bg-card p-5 sm:p-6">
      <h2 id="sent" className="font-semibold text-lg">
        Emails sent
      </h2>
      {emails === undefined ? (
        <Skeleton className="h-16 rounded-xl" />
      ) : emails.length === 0 ? (
        <p className="text-muted-foreground">
          None yet. Once your address is confirmed, each alert is listed here with when it was sent.
        </p>
      ) : (
        <ul className="grid divide-y">
          {emails.map((e) => (
            <li
              key={e.id}
              className="grid gap-1 py-3 sm:grid-cols-[96px_1fr_auto] sm:items-baseline sm:gap-4"
            >
              <span className="font-mono text-muted-foreground text-xs uppercase tracking-[0.08em]">
                {EVENTS[e.event] ?? e.event}
              </span>
              <span className="grid min-w-0 gap-0.5">
                <span className="text-pretty">{e.subject}</span>
                <span className="flex flex-wrap gap-x-3 text-muted-foreground text-sm">
                  <span className="truncate">{e.address}</span>
                  {e.logIndex ? <span className="font-mono">Log entry #{e.logIndex}</span> : null}
                  {e.alibiUrl ? (
                    <a
                      href={e.alibiUrl}
                      target="_blank"
                      rel="noopener"
                      className="underline underline-offset-4"
                    >
                      Alibi
                    </a>
                  ) : null}
                </span>
              </span>
              <span className={`text-sm tnum ${e.sentAt ? "text-muted-foreground" : "text-warn"}`}>
                {e.sentAt
                  ? `Sent ${when(e.sentAt)}`
                  : e.error
                    ? "Not sent"
                    : `Stored ${when(e.createdAt)}, not sent`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** `/alerts/`: phone approvals on this device, the email for alerts and what was sent to it. */
export function AlertsPage() {
  const [emails, setEmails] = useState<SentEmail[]>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    get<{ emails: SentEmail[] }>("/v1/alerts/emails").then(
      (r) => setEmails(r.emails),
      (e) => setError(message(e)),
    );
  }, []);
  useEffect(load, [load]);
  return (
    <AppShell>
      <div className="grid max-w-3xl gap-5">
        <PageHead
          title="Alerts"
          line="Hear from Keelson the moment an agent needs you, and keep a record of what it did."
        />
        <PhoneApprovals />
        <EmailAlerts onChange={load} />
        <Trail emails={emails} />
        {error ? <ErrorNotice>{error}</ErrorNotice> : null}
      </div>
    </AppShell>
  );
}
