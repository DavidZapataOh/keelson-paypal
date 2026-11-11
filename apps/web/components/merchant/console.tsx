"use client";

import type { AgStudioApi } from "ag-studio";
import { Radio, Store, Trophy } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../lib/api";
import { authClient, SESSION_HINT } from "../../lib/auth";
import {
  CHAIN_ID,
  disputesOf,
  type Evaluations,
  evaluationsOf,
  injectedWallet,
  type MerchantDispute,
  type MerchantOrder,
  type MerchantSelf,
  me,
  ordersOf,
  type Settlement,
  settlementOf,
  signIn,
} from "../../lib/merchant";
import { AppShell, type NavItem } from "../app-shell";
import { ConsoleSignIn } from "../console-sign-in";
import { Orders } from "./orders";
import { consequence, SettlementSheet } from "./settlement";

// Studio renders only in the browser; the static export ships its shell.
const MerchantStudio = dynamic(() => import("./studio"), {
  ssr: false,
  loading: () => <p className="p-6 text-muted-foreground text-sm">Loading the console…</p>,
});

const NAV: NavItem[] = [
  { href: "/merchant/", label: "Console", icon: Store },
  { href: "/live/", label: "Live", icon: Radio },
  { href: "/scoreboard/", label: "Scoreboard", icon: Trophy },
];

type Phase =
  | { kind: "loading" }
  | { kind: "signed-out"; reason?: string }
  | {
      kind: "ready";
      merchant: MerchantSelf;
      settlement: Settlement;
      disputes: MerchantDispute[];
      orders: MerchantOrder[];
      evaluations: Evaluations;
    };

const PAGES = [
  { id: "disputes", label: "Disputes" },
  { id: "forensics", label: "Forensics" },
] as const;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

async function load(merchant: MerchantSelf): Promise<Phase> {
  const [settlement, disputes, orders, evaluations] = await Promise.all([
    settlementOf(merchant.merchant_id),
    disputesOf(merchant.merchant_id),
    ordersOf(merchant.merchant_id),
    evaluationsOf(merchant.merchant_id),
  ]);
  return { kind: "ready", merchant, settlement, disputes, orders, evaluations };
}

function SignIn({
  pending,
  reason,
  onSignedIn,
}: {
  pending: boolean;
  reason?: string;
  onSignedIn: (m: MerchantSelf) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  async function go() {
    const wallet = injectedWallet();
    if (!wallet) {
      setFailure(
        "No browser wallet found. Open the console in a browser whose wallet holds your settlement key.",
      );
      return;
    }
    setBusy(true);
    setFailure("");
    try {
      onSignedIn(await signIn(wallet));
    } catch (err) {
      setFailure(
        err instanceof ApiError && err.status === 403
          ? "This wallet is not a merchant's settlement address. Sign in with the address that signs your payout choices."
          : (err as { code?: number }).code === 4001
            ? "You rejected the signature."
            : (err as Error).message,
      );
      if (err instanceof ApiError) await authClient.signOut();
    } finally {
      setBusy(false);
    }
  }
  return (
    <ConsoleSignIn
      title="Merchant console"
      line="Sign in with your settlement wallet."
      chainId={CHAIN_ID}
      pending={pending}
      busy={busy}
      error={failure || reason}
      onSignIn={go}
    />
  );
}

/**
 * The merchant console: sign-in with the settlement wallet, the agents' orders with what Keelson
 * blocked, the settlement choice, and the AG Studio report over disputes and evaluations.
 */
export function MerchantConsole() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [sheet, setSheet] = useState(false);
  const [api, setApi] = useState<AgStudioApi>();
  const [page, setPage] = useState("disputes");
  const [model, setModel] = useState<string>();

  const open = useCallback(async (merchant?: MerchantSelf) => {
    // Without a session there is nothing to read: the visitor signs in first.
    if (!merchant && !localStorage.getItem(SESSION_HINT)) {
      setPhase({ kind: "signed-out" });
      return;
    }
    try {
      setPhase(await load(merchant ?? (await me())));
    } catch (err) {
      setPhase({
        kind: "signed-out",
        ...(err instanceof ApiError && err.status === 403
          ? { reason: "This session is not a merchant's. Sign in with your settlement wallet." }
          : {}),
      });
    }
  }, []);
  useEffect(() => {
    void open();
  }, [open]);

  if (phase.kind === "loading" || phase.kind === "signed-out") {
    // A visitor's view is the static first paint; a browser with a session hides it
    // (html[data-session]) until the session is read.
    return (
      <AppShell nav={NAV} account={null}>
        <SignIn
          pending={phase.kind === "loading"}
          {...(phase.kind === "signed-out" && phase.reason ? { reason: phase.reason } : {})}
          onSignedIn={(m) => void open(m)}
        />
      </AppShell>
    );
  }
  const { merchant, settlement } = phase;
  const signOut = () => authClient.signOut().then(() => setPhase({ kind: "signed-out" }));
  return (
    <AppShell
      nav={NAV}
      wide
      account={{
        name: merchant.name,
        detail: merchant.read_only ? "Read only" : short(merchant.settlement_address),
        onSignOut: merchant.read_only
          ? () => authClient.signOut().then(() => location.assign("/judge/"))
          : signOut,
      }}
    >
      <div className="grid gap-6">
        <header className="grid gap-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h1 className="font-semibold text-[1.75rem] leading-[1.1] tracking-[-0.025em]">
              {merchant.name}
            </h1>
            {merchant.read_only ? (
              <span className="rounded-md border px-2 py-1 font-mono text-[11px] text-muted-foreground">
                Judge Mode · read only
              </span>
            ) : null}
            {merchant.read_only ? (
              <Link
                href="/judge/"
                className="ml-auto font-medium text-sm underline-offset-4 hover:underline"
              >
                Back to the tour
              </Link>
            ) : null}
          </div>
          <p className="text-pretty text-muted-foreground" data-testid="settlement-summary">
            {consequence(merchant, settlement)}{" "}
            {merchant.read_only ? null : (
              <button
                type="button"
                className="font-medium text-foreground underline-offset-4 hover:underline"
                onClick={() => setSheet(true)}
              >
                Change
              </button>
            )}
          </p>
        </header>

        <Orders orders={phase.orders} />

        <section
          aria-label="Disputes and forensics"
          className="grid gap-4 rounded-3xl border bg-card p-3 sm:p-4"
        >
          <div className="flex flex-wrap items-center gap-3 px-2 pt-1">
            <nav aria-label="Console pages" className="flex gap-1 rounded-xl bg-bone-2 p-1">
              {PAGES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-current={page === p.id ? "page" : undefined}
                  disabled={!api}
                  onClick={() => {
                    if (!api) return;
                    api.setState({ ...api.getState(), selectedPageId: p.id });
                    setPage(p.id);
                  }}
                  className="h-8 rounded-lg px-3 text-sm disabled:opacity-60 aria-[current=page]:bg-card aria-[current=page]:font-medium aria-[current=page]:shadow-[0_1px_3px_rgb(23_24_27/0.12)]"
                >
                  {p.label}
                </button>
              ))}
            </nav>
            {model === "claude-haiku-5-5" ? (
              <span className="text-muted-foreground text-sm">
                {merchant.read_only
                  ? "Assistant on Claude Haiku 5.5: this session's budget is spent"
                  : "Assistant on Claude Haiku 5.5: today's budget is spent"}
              </span>
            ) : null}
          </div>
          <div className="h-[calc(100dvh-12rem)] min-h-[560px] overflow-hidden rounded-2xl border bg-background">
            <MerchantStudio
              merchantId={merchant.merchant_id}
              disputes={phase.disputes}
              evaluations={phase.evaluations}
              onModel={setModel}
              onApi={setApi}
              onPage={setPage}
            />
          </div>
        </section>
      </div>
      <SettlementSheet
        open={sheet}
        onOpenChange={setSheet}
        merchant={merchant}
        current={settlement}
        onSaved={(s) => setPhase({ ...phase, settlement: s })}
      />
    </AppShell>
  );
}
