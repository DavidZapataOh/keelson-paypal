"use client";

import { Badge } from "@keelson/ui/components/badge";
import { Button } from "@keelson/ui/components/button";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../lib/api";
import { authClient } from "../../lib/auth";
import { CHAIN_ID, injectedWallet, me, type OperatorSelf, signIn } from "../../lib/operator";
import { Standing } from "./standing";

// AG Grid renders only in the browser; the static export ships the console's shell.
const CoverageBook = dynamic(() => import("./book"), {
  ssr: false,
  loading: () => <p className="py-8 text-muted-foreground text-sm">Loading the coverage book…</p>,
});

type Phase =
  | { kind: "loading" }
  | { kind: "signed-out"; reason?: string }
  | { kind: "ready"; self: OperatorSelf; agentId: string };

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function SignIn({
  reason,
  onSignedIn,
}: {
  reason?: string;
  onSignedIn: (s: OperatorSelf) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(reason);
  async function go() {
    const wallet = injectedWallet();
    if (!wallet) {
      setError(
        "No browser wallet found. Open the console in a browser whose wallet holds your agent's owner key.",
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
    <section aria-labelledby="sign-in" className="mx-auto grid max-w-md gap-5 py-16">
      <Badge variant="outline" className="w-fit font-mono">
        Arbitrum Sepolia · PayPal sandbox
      </Badge>
      <h1 id="sign-in" className="text-balance font-semibold text-4xl tracking-[-0.03em]">
        Operator console
      </h1>
      <p className="text-pretty text-lg text-muted-foreground">
        Your agent's bond, its trust grade and premium, and every purchase the bond covers. Sign in
        with the wallet that owns your agent.
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
      <p role="status" className="min-h-6 text-destructive text-sm">
        {error}
      </p>
    </section>
  );
}

/**
 * The operator console: sign-in with the agent owner's wallet, the bond and grade, the gasless
 * deposit, and the coverage book in AG Grid.
 */
export function OperatorConsole() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  const open = useCallback(async (self?: OperatorSelf) => {
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

  if (phase.kind === "loading") {
    return <p className="py-16 text-muted-foreground">Checking your session…</p>;
  }
  if (phase.kind === "signed-out") {
    return (
      <SignIn
        {...(phase.reason ? { reason: phase.reason } : {})}
        onSignedIn={(s) => void open(s)}
      />
    );
  }
  const { self, agentId } = phase;
  const operator = self.operators.find((o) => o.agentId === agentId);
  const wallet = self.wallets[0] as `0x${string}`;
  return (
    <div className="ml-[calc(50%-50vw)] grid w-screen gap-8 px-5 pb-16 sm:px-8">
      <div className="mx-auto grid w-full max-w-[1440px] gap-8">
        <header className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <h1 className="font-semibold text-2xl tracking-tight">{operator?.name}</h1>
          {self.operators.length > 1 ? (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Agent</span>
              <select
                className="h-8 rounded-md border bg-background px-2 font-mono"
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
            <span className="font-mono text-muted-foreground text-sm">Agent #{agentId}</span>
          )}
          <Badge variant="outline" className="font-mono">
            Arbitrum Sepolia
          </Badge>
          <span className="ml-auto font-mono text-muted-foreground text-sm" title={wallet}>
            {short(wallet)}
          </span>
          <button
            type="button"
            className="text-muted-foreground text-sm hover:text-foreground"
            onClick={() => authClient.signOut().then(() => setPhase({ kind: "signed-out" }))}
          >
            Sign out
          </button>
        </header>
        <Standing key={`standing-${agentId}`} agentId={agentId} owner={wallet} />
        <CoverageBook key={`book-${agentId}`} agentId={agentId} />
      </div>
    </div>
  );
}
