"use client";

import { Home, KeyRound, LogOut, Plus, Radio, Scale, Trophy } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { authClient } from "../lib/auth";
import { useSessionHint } from "./header";

const PUBLIC = new Set(["/live/", "/scoreboard/"]);

const NAV = [
  { href: "/", label: "Home", icon: Home },
  { href: "/new/", label: "New mandate", icon: Plus },
  { href: "/disputes/", label: "Disputes", icon: Scale },
  { href: "/live/", label: "Live", icon: Radio },
  { href: "/scoreboard/", label: "Scoreboard", icon: Trophy },
  { href: "/passkeys/", label: "Passkeys", icon: KeyRound },
] as const;

/** The signed-in app: a sidebar on desktop, a tab bar on a phone. */
export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const session = useSessionHint();
  const name = session?.user.name || session?.user.email || "";
  const nav = session ? NAV : NAV.filter((n) => PUBLIC.has(n.href));
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="sticky top-0 hidden h-dvh flex-col border-r bg-bone-2/60 px-4 py-6 lg:flex">
        <Link href="/" className="mb-8 rounded-sm px-2" aria-label="Keelson, home">
          {/* biome-ignore lint/performance/noImgElement: a static export serves the SVG as is */}
          <img src="/keelson.svg" alt="" width={94} height={28} className="h-7 w-auto" />
        </Link>
        <nav aria-label="Main" className="grid gap-0.5">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={active(href) ? "page" : undefined}
              className="flex h-10 items-center gap-3 rounded-lg px-3 text-[15px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground aria-[current=page]:bg-card aria-[current=page]:text-foreground aria-[current=page]:shadow-[0_1px_3px_rgb(23_24_27/0.1)]"
            >
              <Icon className="size-[18px]" aria-hidden="true" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto grid gap-3 px-2">
          <span className="w-fit rounded-md border px-2 py-1 font-mono text-[11px] text-muted-foreground">
            PayPal sandbox
          </span>
          {session ? null : (
            <Link
              href="/"
              className="grid h-11 place-items-center rounded-xl bg-graphite font-medium text-bone text-sm"
            >
              Get started
            </Link>
          )}
          <div className={session ? "flex items-center gap-3" : "hidden"}>
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-graphite font-medium text-bone text-xs uppercase">
              {name.slice(0, 1)}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
            <button
              type="button"
              onClick={() => authClient.signOut().then(() => location.assign("/"))}
              className="grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
              aria-label="Sign out"
            >
              <LogOut className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="flex h-14 items-center justify-between px-5 lg:hidden">
          {/* biome-ignore lint/performance/noImgElement: a static export serves the SVG as is */}
          <img src="/keelson.svg" alt="Keelson" width={94} height={28} className="h-6 w-auto" />
          <span className="rounded-md border px-2 py-1 font-mono text-[11px] text-muted-foreground">
            Sandbox
          </span>
        </header>
        <main
          id="main"
          className="mx-auto w-full max-w-[1120px] px-4 pt-2 pb-28 sm:px-8 lg:pt-10 lg:pb-16"
        >
          {children}
        </main>
      </div>

      <nav
        aria-label="Main"
        style={{ gridTemplateColumns: `repeat(${nav.length}, minmax(0, 1fr))` }}
        className="fixed inset-x-3 bottom-[max(12px,env(safe-area-inset-bottom))] z-30 grid rounded-2xl border bg-card/95 p-1.5 shadow-[0_18px_40px_-18px_rgb(23_24_27/0.4)] backdrop-blur-md lg:hidden"
      >
        {nav.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            aria-current={active(href) ? "page" : undefined}
            className="grid h-14 place-items-center content-center gap-1 rounded-xl text-[11px] text-muted-foreground aria-[current=page]:bg-bone-2 aria-[current=page]:text-foreground"
          >
            <Icon className="size-5" aria-hidden="true" />
            {label === "New mandate" ? "New" : label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
