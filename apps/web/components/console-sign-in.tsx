"use client";

import { Button } from "@keelson/ui/components/button";
import { DataItem, DataList } from "@keelson/ui/components/data-list";
import { cn } from "@keelson/ui/lib/utils";
import { Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorNotice } from "./notice";

/** The page's host, read after hydration so the static first paint and the client agree. */
function Host() {
  const [host, setHost] = useState("");
  useEffect(() => setHost(location.host), []);
  return <>{host}</>;
}

/** A console's sign-in: the wallet it asks for and exactly what that wallet signs. */
export function ConsoleSignIn({
  title,
  line,
  chainId,
  pending,
  busy,
  error,
  onSignIn,
}: {
  title: string;
  line: string;
  chainId: number;
  pending: boolean;
  busy: boolean;
  error: string | undefined;
  onSignIn: () => void;
}) {
  return (
    <section
      aria-labelledby="sign-in"
      className={cn("mx-auto grid max-w-md gap-6 lg:pt-10", pending && "pending-session")}
    >
      <div className="grid gap-2">
        <h1 id="sign-in" className="font-semibold text-[1.75rem] leading-[1.1] tracking-[-0.025em]">
          {title}
        </h1>
        <p className="text-pretty text-lg text-muted-foreground leading-snug">{line}</p>
      </div>
      <div className="grid gap-5 rounded-3xl border bg-card p-5 sm:p-6">
        <span className="grid size-10 place-items-center rounded-xl bg-bone-2">
          <Wallet className="size-5" aria-hidden="true" />
        </span>
        <DataList layout="stacked">
          <DataItem label="You sign">Sign-In with Ethereum (EIP-4361)</DataItem>
          <DataItem label="For">
            <span className="font-mono">
              <Host />
            </span>
          </DataItem>
          <DataItem label="Chain">
            <span className="font-mono tnum">{chainId}</span>
          </DataItem>
          <DataItem label="Valid for">10 minutes, once</DataItem>
        </DataList>
        <Button size="lg" onClick={onSignIn} disabled={busy || pending}>
          {busy ? "Waiting for your wallet…" : "Sign in with wallet"}
        </Button>
      </div>
      <div role="status" className="min-h-6">
        {error ? <ErrorNotice>{error}</ErrorNotice> : null}
      </div>
    </section>
  );
}
