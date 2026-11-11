"use client";

import { Radio, ShieldCheck, Trophy } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../lib/api";
import { authClient, SESSION_HINT } from "../../lib/auth";
import { CHAIN_ID, injectedWallet, me, type OperatorSelf, signIn } from "../../lib/operator";
import { AppShell, type NavItem } from "../app-shell";
import { ConsoleSignIn } from "../console-sign-in";
import { LogBonds } from "../log-bond";
import { Standing } from "./standing";

// AG Grid renders only in the browser; the static export ships the console's shell.
const CoverageBook = dynamic(() => import("./book"), {
  ssr: false,
  loading: () => <p className="py-8 text-muted-foreground text-sm">Loading the coverage book…</p>,
});

const NAV: NavItem[] = [
  { href: "/operator/", label: "Console", icon: ShieldCheck },
  { href: "/live/", label: "Live", icon: Radio },
  { href: "/scoreboard/", label: "Scoreboard", icon: Trophy },
];

type Phase =
  | { kind: "loading" }
  | { kind: "signed-out"; reason?: string }
  | { kind: "ready"; self: OperatorSelf; agentId: string };

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function SignIn({
  pending,
  reason,
  onSignedIn,
}: {
  pending: boolean;
  reason?: string;
  onSignedIn: (s: OperatorSelf) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  async function go() {
    const wallet = injectedWallet();
    if (!wallet) {
      setFailure(
        "No browser wallet found. Open the console in a browser whose wallet holds your agent's owner key.",
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
          ? "This wallet owns no linked agent. Sign in with the address that owns your agent in the ERC-8004 Identity registry."
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
      title="Operator console"
      line="Sign in with the wallet that owns your agent."
      chainId={CHAIN_ID}
      pending={pending}
      busy={busy}
      error={failure || reason}
      onSignIn={go}
    />
  );
}

/**
 * The operator console: sign-in with the agent owner's wallet, the bond and grade, the gasless
 * top-up, and the coverage book in AG Grid.
 */
export function OperatorConsole() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  const open = useCallback(async (self?: OperatorSelf) => {
    // Without a session there is nothing to read: the visitor signs in first.
    if (!self && !localStorage.getItem(SESSION_HINT)) {
      setPhase({ kind: "signed-out" });
      return;
    }
    try {
      const s = self ?? (await me());
      const first = s.operators[0];
      setPhase(first ? { kind: "ready", self: s, agentId: first.agentId } : { kind: "signed-out" });
    } catch (err) {
      setPhase({
        kind: "signed-out",
        ...(err instanceof ApiError && err.status === 403
          ? { reason: "This session owns no agent. Sign in with your agent's owner wallet." }
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
          onSignedIn={(s) => void open(s)}
        />
      </AppShell>
    );
  }
  const { self, agentId } = phase;
  const operator = self.operators.find((o) => o.agentId === agentId);
  const wallet = self.wallets[0] as `0x${string}`;
  return (
    <AppShell
      nav={NAV}
      wide
      account={{
        name: operator?.name ?? `Agent #${agentId}`,
        detail: short(wallet),
        onSignOut: () => authClient.signOut().then(() => setPhase({ kind: "signed-out" })),
      }}
    >
      <div className="grid gap-8">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="font-semibold text-[1.75rem] leading-[1.1] tracking-[-0.025em]">
            {operator?.name}
          </h1>
          {self.operators.length > 1 ? (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Agent</span>
              <select
                className="h-9 rounded-lg border bg-card px-2 font-mono"
                value={agentId}
                onChange={(e) => setPhase({ ...phase, agentId: e.target.value })}
              >
                {self.operators.map((o) => (
                  <option key={o.agentId} value={o.agentId}>
                    #{o.agentId}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="rounded-md bg-bone-2 px-2 py-1 font-mono text-muted-foreground text-xs">
              Agent #{agentId}
            </span>
          )}
        </header>
        <Standing key={`standing-${agentId}`} agentId={agentId} owner={wallet} />
        <CoverageBook key={`book-${agentId}`} agentId={agentId} />
        <section
          aria-labelledby="log-bond-title"
          className="grid gap-4 rounded-3xl border bg-card p-5 sm:p-6"
        >
          <div className="grid max-w-prose gap-1">
            <h2 id="log-bond-title" className="font-semibold text-lg tracking-tight">
              The log is bonded too
            </h2>
            <p className="text-pretty text-muted-foreground text-sm">
              If it ever signs two histories, anyone takes its bond with the two checkpoints.
            </p>
          </div>
          <LogBonds />
        </section>
      </div>
    </AppShell>
  );
}
