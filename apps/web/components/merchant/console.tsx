"use client";

import { Badge } from "@keelson/ui/components/badge";
import { Button } from "@keelson/ui/components/button";
import type { AgStudioApi } from "ag-studio";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../lib/api";
import { authClient } from "../../lib/auth";
import {
  CHAIN_ID,
  disputesOf,
  type Evaluations,
  evaluationsOf,
  injectedWallet,
  type MerchantDispute,
  type MerchantSelf,
  me,
  type Settlement,
  settlementOf,
  signIn,
} from "../../lib/merchant";
import { consequence, SettlementSheet } from "./settlement";

// Studio renders only in the browser; the static export ships its shell.
const MerchantStudio = dynamic(() => import("./studio"), {
  ssr: false,
  loading: () => <p className="p-6 text-muted-foreground text-sm">Loading the console…</p>,
});

type Phase =
  | { kind: "loading" }
  | { kind: "signed-out"; reason?: string }
  | {
      kind: "ready";
      merchant: MerchantSelf;
      settlement: Settlement;
      disputes: MerchantDispute[];
      evaluations: Evaluations;
    };

const PAGES = [
  { id: "disputes", label: "Disputes" },
  { id: "forensics", label: "Forensics" },
] as const;

async function load(merchant: MerchantSelf): Promise<Phase> {
  const [settlement, disputes, evaluations] = await Promise.all([
    settlementOf(merchant.merchant_id),
    disputesOf(merchant.merchant_id),
    evaluationsOf(merchant.merchant_id),
  ]);
  return { kind: "ready", merchant, settlement, disputes, evaluations };
}

function SignIn({
  reason,
  onSignedIn,
}: {
  reason?: string;
  onSignedIn: (m: MerchantSelf) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(reason);
  async function go() {
    const wallet = injectedWallet();
    if (!wallet) {
      setError(
        "No browser wallet found. Open the console in a browser whose wallet holds your settlement key.",
      );
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      onSignedIn(await signIn(wallet));
    } catch (err) {
      setError(
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
    <section aria-labelledby="sign-in" className="mx-auto grid max-w-md gap-5 py-16">
      <Badge variant="outline" className="w-fit font-mono">
        PayPal sandbox · Arbitrum Sepolia
      </Badge>
      <h1 id="sign-in" className="text-balance font-semibold text-4xl tracking-[-0.03em]">
        Merchant console
      </h1>
      <p className="text-pretty text-lg text-muted-foreground">
        Your disputes over agent purchases, the verdict on each, and which agents fail which mandate
        checks. Sign in with your settlement wallet: the address that signs your payout choices.
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-[10px] border p-4 text-sm">
        <dt className="text-muted-foreground">You sign</dt>
        <dd>A Sign-In with Ethereum message (EIP-4361)</dd>
        <dt className="text-muted-foreground">For</dt>
        <dd className="font-mono">{typeof location === "undefined" ? "" : location.host}</dd>
        <dt className="text-muted-foreground">Chain</dt>
        <dd className="font-mono">{CHAIN_ID}</dd>
        <dt className="text-muted-foreground">Valid for</dt>
        <dd>10 minutes, once</dd>
      </dl>
      <Button size="lg" onClick={go} disabled={busy}>
        {busy ? "Waiting for your wallet…" : "Sign in with wallet"}
      </Button>
      <p role="status" className="min-h-6 text-sm text-destructive">
        {error}
      </p>
    </section>
  );
}

/**
 * The merchant console: sign-in with the settlement wallet, the settlement choice, and the AG
 * Studio report over the merchant's disputes and agent evaluations.
 */
export function MerchantConsole() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [sheet, setSheet] = useState(false);
  const [api, setApi] = useState<AgStudioApi>();
  const [page, setPage] = useState("disputes");
  const [model, setModel] = useState<string>();

  const open = useCallback(async (merchant?: MerchantSelf) => {
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

  if (phase.kind === "loading") {
    return <p className="py-16 text-muted-foreground">Checking your session…</p>;
  }
  if (phase.kind === "signed-out") {
    return (
      <SignIn
        {...(phase.reason ? { reason: phase.reason } : {})}
        onSignedIn={(m) => void open(m)}
      />
    );
  }
  const { merchant, settlement } = phase;
  return (
    <div className="-mt-6 ml-[calc(50%-50vw)] grid h-[calc(100dvh-4rem)] w-screen grid-rows-[auto_1fr] border-t">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 sm:px-8">
        <h1 className="font-semibold text-xl tracking-tight">{merchant.name}</h1>
        <nav aria-label="Console pages" className="flex gap-1">
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
              className="rounded-md px-3 py-1.5 font-medium text-sm text-muted-foreground hover:bg-accent aria-[current=page]:bg-foreground aria-[current=page]:text-background"
            >
              {p.label}
            </button>
          ))}
        </nav>
        <p className="mr-auto text-sm" data-testid="settlement-summary">
          {consequence(merchant, settlement)}{" "}
          {merchant.read_only ? null : (
            <button type="button" className="underline" onClick={() => setSheet(true)}>
              Change
            </button>
          )}
        </p>
        {merchant.read_only ? (
          <Badge variant="outline" className="font-mono">
            Judge Mode · read only
          </Badge>
        ) : null}
        {model === "claude-haiku-5-5" ? (
          <Badge variant="outline">
            {merchant.read_only
              ? "Assistant on Claude Haiku 5.5: this session's budget is spent"
              : "Assistant on Claude Haiku 5.5: today's budget is spent"}
          </Badge>
        ) : null}
        {merchant.read_only ? (
          <Link href="/judge/" className="font-medium text-sm underline">
            Back to the tour
          </Link>
        ) : (
          <button
            type="button"
            className="text-muted-foreground text-sm hover:text-foreground"
            onClick={() => authClient.signOut().then(() => setPhase({ kind: "signed-out" }))}
          >
            Sign out
          </button>
        )}
      </div>
      <div className="min-h-0">
        <MerchantStudio
          merchantId={merchant.merchant_id}
          disputes={phase.disputes}
          evaluations={phase.evaluations}
          onModel={setModel}
          onApi={setApi}
          onPage={setPage}
        />
      </div>
      <SettlementSheet
        open={sheet}
        onOpenChange={setSheet}
        merchant={merchant}
        current={settlement}
        onSaved={(s) => setPhase({ ...phase, settlement: s })}
      />
    </div>
  );
}
