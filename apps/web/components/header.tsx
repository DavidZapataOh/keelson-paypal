"use client";

import { Badge } from "@keelson/ui/components/badge";
import Link from "next/link";
import { useEffect } from "react";
import { authClient, SESSION_HINT } from "../lib/auth";

/** Keeps the first-paint hint in step with the session, so a signed-in browser skips the welcome. */
export function useSessionHint() {
  const { data, isPending } = authClient.useSession();
  useEffect(() => {
    if (isPending) return;
    if (data) localStorage.setItem(SESSION_HINT, "1");
    else {
      localStorage.removeItem(SESSION_HINT);
      delete document.documentElement.dataset.session;
    }
  }, [data, isPending]);
  return data;
}

export function Header() {
  const data = useSessionHint();
  return (
    <header className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-5 sm:px-8">
      <Link href="/" className="rounded-sm" aria-label="Keelson, home">
        {/* biome-ignore lint/performance/noImgElement: a static export serves the SVG as is */}
        <img src="/keelson.svg" alt="" width={94} height={28} className="h-7 w-auto" />
      </Link>
      <Badge variant="outline" className="mr-auto ml-3 font-mono">
        PayPal sandbox
      </Badge>
      <Link
        href="/scoreboard/"
        className="rounded-md px-3 py-2.5 font-medium text-sm hover:bg-accent"
      >
        Scoreboard
      </Link>
      <Link href="/live/" className="rounded-md px-3 py-2.5 font-medium text-sm hover:bg-accent">
        Live purchases
      </Link>
      {data ? (
        <nav aria-label="Account" className="flex items-center gap-1 text-sm">
          <Link href="/new/" className="rounded-md px-3 py-2.5 font-medium hover:bg-accent">
            New mandate
          </Link>
          <Link href="/passkeys/" className="rounded-md px-3 py-2.5 font-medium hover:bg-accent">
            Passkeys
          </Link>
          <button
            type="button"
            onClick={() => authClient.signOut().then(() => location.assign("/"))}
            className="rounded-md px-3 py-2.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Sign out
          </button>
        </nav>
      ) : null}
    </header>
  );
}
