"use client";

import { Skeleton } from "@keelson/ui/components/skeleton";
import { ArrowUpRight, Check, ChevronRight, Plus, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { get } from "../lib/api";
import { VERIFY } from "../lib/config";
import { money } from "../lib/format";
import { purchaseStatus } from "../lib/status";
import type { MandateSummary, MandateView, Purchase } from "../lib/types";
import { useMandate } from "../lib/use-mandate";
import { AppShell } from "./app-shell";
import { CardAmount, MandateVisual } from "./mandate-visual";
import { ErrorNotice } from "./notice";
import { WhoAnswers } from "./who-answers";

const short = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(
    new Date(iso),
  );
const time = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(iso));

function day(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric" }).format(d);
}

/** Store names as the signed card spells them, keyed by the merchant id. */
function storeNames(m: MandateView): (id: string) => string {
  const names = (m.card?.rows.find((r) => r.field === "merchant")?.values ?? []).map(
    (v) => v.split(" (")[0] ?? v,
  );
  return (id: string) => {
    const bare = id.replace(/^mrc_/, "");
    return (
      names.find((n) => n.toLowerCase().replace(/\W/g, "") === bare.replace(/\W/g, "")) ??
      bare.charAt(0).toUpperCase() + bare.slice(1)
    );
  };
}

const FIELD_WORDS: Record<string, string> = {
  total: "over your cap",
  budget: "over your budget",
  merchant: "a store you did not allow",
  deadline: "after your deadline",
  items: "an item you did not ask for",
  category: "outside your categories",
  variant: "the wrong size or variant",
  quantity: "the wrong quantity",
};

function blockedWhy(p: Purchase): string {
  const field = p.blocked?.[0];
  if (field) return FIELD_WORDS[field] ?? `outside your ${field}`;
  return p.failure?.reason ?? "outside your rules";
}

type Kind = "bought" | "blocked" | "checking" | "attention";

function kindOf(p: Purchase): Kind {
  const s = purchaseStatus(p);
  if (s === "blocked") return "blocked";
  if (s === "checking") return "checking";
  if (s === "error" || s === "disputed") return "attention";
  return "bought";
}

function Mark({ kind }: { kind: Kind }) {
  const base = "grid size-10 shrink-0 place-items-center rounded-xl";
  if (kind === "blocked")
    return (
      <span className={`${base} bg-vermilion text-graphite`}>
        <X className="size-5" strokeWidth={2.5} aria-hidden="true" />
      </span>
    );
  if (kind === "bought")
    return (
      <span className={`${base} bg-ok text-bone`}>
        <Check className="size-5" strokeWidth={2.5} aria-hidden="true" />
      </span>
    );
  return (
    <span className={`${base} bg-bone-2`}>
      <span
        className={`size-2.5 rounded-full ${kind === "checking" ? "animate-pending bg-foreground" : "bg-warn"}`}
      />
    </span>
  );
}

const SAY: Record<Kind, string> = {
  bought: "Bought",
  blocked: "Blocked",
  checking: "Checking",
  attention: "Needs a look",
};

function Row({ p, store, mandateId }: { p: Purchase; store: string; mandateId: string }) {
  const kind = kindOf(p);
  return (
    <li>
      <Link
        href={`/purchase/?mandate=${mandateId}&id=${p.id}`}
        className="-mx-2 flex items-center gap-3.5 rounded-xl px-2 py-2.5 transition-colors hover:bg-foreground/4"
      >
        <Mark kind={kind} />
        <span className="grid min-w-0 flex-1 leading-tight">
          <span className="truncate font-medium">{store}</span>
          <span className="truncate text-muted-foreground text-sm">
            {SAY[kind]}
            {kind === "blocked" ? ` · ${blockedWhy(p)}` : ` · ${time(p.createdAt)}`}
          </span>
        </span>
        <span
          className={`font-mono text-[15px] tnum ${kind === "blocked" ? "text-muted-foreground line-through decoration-vermilion-deep" : ""}`}
        >
          {money(p.amount.minor, p.amount.currency)}
        </span>
      </Link>
    </li>
  );
}

function Panel({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="rounded-3xl border bg-card p-5 sm:p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold text-lg tracking-tight">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Action({
  href,
  label,
  icon,
  primary,
  external,
}: {
  href: string;
  label: string;
  icon: ReactNode;
  primary?: boolean;
  external?: boolean;
}) {
  return (
    <Link
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      className="group grid justify-items-center gap-2 text-sm"
    >
      <span
        className={`grid size-14 place-items-center rounded-full transition-transform duration-200 group-hover:-translate-y-0.5 group-active:scale-95 ${primary ? "bg-graphite text-bone" : "bg-bone-2 text-foreground"}`}
      >
        {icon}
      </span>
      {label}
    </Link>
  );
}

const FILTERS = ["All", "Bought", "Blocked"] as const;

function Focus({ id }: { id: string }) {
  const { mandate, error } = useMandate(id);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");

  if (error) return <ErrorNotice>{error}</ErrorNotice>;
  if (!mandate) {
    return (
      <div className="grid gap-6 lg:grid-cols-[1fr_400px]" aria-hidden="true">
        <Skeleton className="h-56 rounded-3xl" />
        <Skeleton className="aspect-[1.586/1] rounded-[22px]" />
      </div>
    );
  }

  const { budget } = mandate;
  const left = Number(budget.remainingMinor) / 100;
  const max = Number(budget.maxMinor) / 100;
  const store = storeNames(mandate);
  const purchases = [...mandate.purchases].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const blocked = purchases.filter((p) => kindOf(p) === "blocked");
  const bought = purchases.filter((p) => kindOf(p) === "bought");
  const shown = filter === "Bought" ? bought : filter === "Blocked" ? blocked : purchases;
  const days = [...new Set(shown.map((p) => day(p.createdAt)))];
  const what =
    mandate.card?.rows.find((r) => r.field === "items")?.values.join(", ") ??
    mandate.card?.rows.find((r) => r.field === "summary")?.values[0] ??
    "";
  const stores = (mandate.card?.rows.find((r) => r.field === "merchant")?.values ?? []).map(
    (v) => v.split(" (")[0] ?? v,
  );
  const counts = { All: purchases.length, Bought: bought.length, Blocked: blocked.length };
  const latestBlock = blocked[0];

  return (
    <div className="grid gap-6">
      <h1 className="sr-only">Home</h1>
      <div className="grid items-center gap-8 lg:grid-cols-[1fr_400px]">
        <div className="grid gap-6">
          <div className="grid gap-1">
            <p className="text-muted-foreground">Your agent can still spend</p>
            <p className="text-[3.25rem] leading-none">
              <CardAmount value={left} currency={budget.currency} />
            </p>
            <p className="mt-1 text-muted-foreground">
              of {money(budget.maxMinor, budget.currency)} · until {short(mandate.expiresAt)}
            </p>
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: a native <meter> cannot be drawn as this bar */}
          <div
            role="meter"
            aria-label="Spent"
            aria-valuemin={0}
            aria-valuemax={max}
            aria-valuenow={max - left}
            className="h-2 max-w-md overflow-hidden rounded-full bg-foreground/10"
          >
            <div
              className="h-full origin-left rounded-full bg-graphite transition-transform duration-500"
              style={{ transform: `scaleX(${max > 0 ? (max - left) / max : 0})` }}
            />
          </div>
          <div className="flex gap-6 pt-2">
            <Action href="/new/" label="New" icon={<Plus className="size-6" />} primary />
            <Action
              href={`/mandate/?id=${mandate.id}`}
              label="Details"
              icon={<ShieldCheck className="size-5" />}
            />
            <Action
              href={VERIFY}
              label="Verify"
              icon={<ArrowUpRight className="size-5" />}
              external
            />
          </div>
        </div>
        <MandateVisual
          className="mx-auto max-w-[400px]"
          amount={max}
          currency={budget.currency}
          amountLabel="Up to"
          what={what}
          chips={stores.length > 0 ? stores : ["Any store"]}
          until={short(mandate.expiresAt)}
          state={
            mandate.state === "ACTIVE" ? "Active" : mandate.state.toLowerCase().replace("_", " ")
          }
          seal="closed"
        />
      </div>

      {latestBlock ? (
        <Link
          href={`/purchase/?mandate=${mandate.id}&id=${latestBlock.id}`}
          className="flex items-center gap-4 rounded-3xl border border-vermilion/35 bg-vermilion/[0.06] p-4 transition-colors hover:bg-vermilion/10 sm:p-5"
        >
          <Mark kind="blocked" />
          <span className="grid min-w-0 flex-1 leading-snug">
            <span className="font-semibold">
              Keelson blocked {blocked.length} {blocked.length === 1 ? "cart" : "carts"}
            </span>
            <span className="truncate text-muted-foreground text-sm">
              {store(latestBlock.merchantId)} ·{" "}
              {money(latestBlock.amount.minor, latestBlock.amount.currency)} ·{" "}
              {blockedWhy(latestBlock)} · nothing paid
            </span>
          </span>
          <ChevronRight className="size-5 text-muted-foreground" aria-hidden="true" />
        </Link>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[1fr_360px]">
        <Panel
          title="Activity"
          aside={
            <div role="tablist" aria-label="Show" className="flex gap-1 rounded-xl bg-bone-2 p-1">
              {FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={filter === f}
                  onClick={() => setFilter(f)}
                  className="h-8 rounded-lg px-3 text-sm aria-selected:bg-card aria-selected:font-medium aria-selected:shadow-[0_1px_3px_rgb(23_24_27/0.12)]"
                >
                  {f} <span className="text-muted-foreground tnum">{counts[f]}</span>
                </button>
              ))}
            </div>
          }
        >
          {shown.length === 0 ? (
            <div className="grid gap-3 py-2">
              {[0, 1].map((i) => (
                <div key={i} className="flex items-center gap-3.5 opacity-50" aria-hidden="true">
                  <span className="size-10 rounded-xl border border-dashed" />
                  <span className="grid flex-1 gap-1.5">
                    <span className="h-3 w-32 rounded-full bg-foreground/10" />
                    <span className="h-2.5 w-20 rounded-full bg-foreground/6" />
                  </span>
                  <span className="h-3 w-14 rounded-full bg-foreground/10" />
                </div>
              ))}
              <p className="pt-2 text-muted-foreground text-sm">
                Purchases show up here the moment your agent buys.
              </p>
            </div>
          ) : (
            <div className="grid gap-4">
              {days.map((d) => (
                <div key={d} className="grid gap-1">
                  <h3 className="font-medium text-muted-foreground text-xs">{d}</h3>
                  <ul className="grid">
                    {shown
                      .filter((p) => day(p.createdAt) === d)
                      .map((p) => (
                        <Row key={p.id} p={p} store={store(p.merchantId)} mandateId={mandate.id} />
                      ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Panel>

        {mandate.card ? (
          <Panel
            title="Who answers"
            aside={
              <Link
                href={`/mandate/?id=${mandate.id}`}
                className="text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
              >
                What you signed
              </Link>
            }
          >
            <WhoAnswers
              card={mandate.card}
              className="[&>li]:animate-none [&>li]:bg-bone-2/60 [&>li]:shadow-none"
            />
          </Panel>
        ) : null}
      </div>
    </div>
  );
}

/** Home: what the agent bought, what Keelson blocked, and who answers if it goes wrong. */
export function Dashboard() {
  const router = useRouter();
  const [mandates, setMandates] = useState<MandateSummary[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    get<{ mandates: MandateSummary[] }>("/v1/mandates")
      .then((r) => {
        // A first-time user continues the guided setup.
        if (r.mandates.length === 0) router.replace("/new/");
        else setMandates(r.mandates);
      })
      .catch((e: Error) => setError(e.message));
  }, [router]);

  const focus = mandates?.find((m) => m.state === "ACTIVE") ?? mandates?.[0];

  return (
    <AppShell>
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
      {focus ? <Focus id={focus.id} /> : null}
    </AppShell>
  );
}
