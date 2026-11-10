"use client";

import Link from "next/link";
import { authClient } from "../lib/auth";

export function Header() {
  const { data } = authClient.useSession();
  return (
    <header className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-5 sm:px-8">
      <Link href="/" className="rounded-sm" aria-label="Keelson, home">
        {/* biome-ignore lint/performance/noImgElement: a static export serves the SVG as is */}
        <img src="/keelson.svg" alt="" width={94} height={28} className="h-7 w-auto" />
      </Link>
      {data ? (
        <nav aria-label="Account" className="flex items-center gap-1 text-sm">
          <Link href="/new/" className="rounded-md px-3 py-2.5 font-medium hover:bg-accent">
            New mandate
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
