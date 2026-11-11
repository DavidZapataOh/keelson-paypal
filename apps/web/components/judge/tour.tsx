"use client";

import { Amount } from "@keelson/ui/components/amount";
import { Button } from "@keelson/ui/components/button";
import { DataItem, DataList } from "@keelson/ui/components/data-list";
import { Timeline, TimelineItem } from "@keelson/ui/components/timeline";
import { cn } from "@keelson/ui/lib/utils";
import { Activity, Gavel, Radio, Trophy } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../lib/api";
import { authClient, SESSION_HINT } from "../../lib/auth";
import { VERIFY } from "../../lib/config";
import { money, when } from "../../lib/format";
import {
  type DisputeStatus,
  disputeOf,
  type Grade,
  gradeOf,
  type StatusReport,
  startJudge,
  statusReport,
  type Tour,
  type TourPurchase,
  tour as tourOf,
} from "../../lib/judge";
import { percent, type Scoreboard, scoreboard } from "../../lib/scoreboard";
import { AmberCase } from "../amber-case";
import { AppShell, type NavItem } from "../app-shell";
import { LogBonds } from "../log-bond";
import { LiabilityLegend, MandateCard } from "../mandate-card";
import { ErrorNotice } from "../notice";
import { Mark, Panel } from "../surface";
import { EnvironmentTable, HealthList } from "./environment";

type Role = "Shopper" | "Merchant" | "Operator";

const STEPS: { id: string; title: string; role: Role; line: string }[] = [
  {
    id: "mandate",
    title: "The mandate",
    role: "Shopper",
    line: "One sentence, compiled into a card and signed with a passkey.",
  },
  {
    id: "agent",
    title: "The agent shops",
    role: "Shopper",
    line: "Two runs at RunFast: one with a planted prompt, one clean.",
  },
  {
    id: "alibi",
    title: "Try to cheat the Alibi",
    role: "Shopper",
    line: "Swap the cart or fake the anchor, and see which check catches it.",
  },
  {
    id: "anonymous",
    title: "Anonymous, and still accountable",
    role: "Shopper",
    line: "A real, registered person approved it. Nobody learns who.",
  },
  {
    id: "equivocation",
    title: "Catch the log lying",
    role: "Shopper",
    line: "Two signed histories of the same log are proof, and its bond pays out.",
  },
  {
    id: "dispute",
    title: "A dispute arrives",
    role: "Merchant",
    line: "A PayPal sandbox dispute, attributed by Keelson.",
  },
  {
    id: "verdict",
    title: "Verdict and settlement",
    role: "Merchant",
    line: "Who pays and under which rule, signed by both TEEs.",
  },
  {
    id: "forensics",
    title: "Merchant forensics",
    role: "Merchant",
    line: "Every dispute, and which checks each agent fails.",
  },
  {
    id: "grade",
    title: "Operator grade",
    role: "Operator",
    line: "The grade prices the premium on every coverage.",
  },
  {
    id: "scoreboard",
    title: "Red-team scoreboard",
    role: "Operator",
    line: "We attack our own agent, continuously.",
  },
  {
    id: "status",
    title: "Live status",
    role: "Operator",
    line: "Everything you just saw, running now.",
  },
];

const ROLES: Role[] = ["Shopper", "Merchant", "Operator"];

const NAV: NavItem[] = [
  { href: "/judge/", label: "Judge Mode", short: "Judge", icon: Gavel },
  { href: "/live/", label: "Live", icon: Radio },
  { href: "/scoreboard/", label: "Scoreboard", icon: Trophy },
  { href: "/status/", label: "Status", icon: Activity },
];

/** Where the tour is, kept across the merchant console and a reload. */
const STEP_KEY = "keelson.judge.step";
const STARTED_KEY = "keelson.judge.started";

type Phase =
  | { kind: "loading" }
  | { kind: "welcome"; signedIn: boolean; error?: string }
  | { kind: "touring"; tour: Tour };

/** Judge Mode: a temporary tenant and a guided walk through the live product. */
export function JudgeMode() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const invite = useRef<string | undefined>(undefined);
  useEffect(() => {
    // A fragment never reaches a server nor a Referer; the invite then leaves the address bar
    // and the history, and stays in memory only.
    const url = new URL(location.href);
    const code = new URLSearchParams(url.hash.slice(1)).get("invite");
    if (code === null) return;
    invite.current = code;
    url.hash = "";
    history.replaceState(history.state, "", url);
  }, []);

  const load = useCallback(async () => {
    // Without a session there is no tenant to read: the visitor starts one first.
    if (!localStorage.getItem(SESSION_HINT)) {
      setPhase({ kind: "welcome", signedIn: false });
      return;
    }
    try {
      setPhase({ kind: "touring", tour: await tourOf() });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setPhase({ kind: "welcome", signedIn: err.status === 403 });
      } else {
        setPhase({ kind: "welcome", signedIn: false, error: (err as Error).message });
      }
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (phase.kind === "touring") return <Walkthrough tour={phase.tour} />;
  // A visitor's welcome is the static first paint; a browser with a session hides it
  // (html[data-session]) until the session is read.
  return (
    <Welcome
      pending={phase.kind === "loading"}
      signedIn={phase.kind === "welcome" && phase.signedIn}
      {...(phase.kind === "welcome" && phase.error ? { error: phase.error } : {})}
      invite={invite}
      onStarted={load}
    />
  );
}

function Welcome({
  pending,
  signedIn,
  error,
  invite,
  onStarted,
}: {
  pending: boolean;
  signedIn: boolean;
  error?: string;
  invite: { current: string | undefined };
  onStarted: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const problem = failure ?? error;
  async function start() {
    setBusy(true);
    setFailure("");
    try {
      if (signedIn) await authClient.signOut();
      await startJudge(invite.current);
      invite.current = undefined;
      localStorage.setItem(SESSION_HINT, "1");
      localStorage.setItem(STEP_KEY, "0");
      localStorage.setItem(STARTED_KEY, String(Date.now()));
      await onStarted();
    } catch (err) {
      setFailure(
        err instanceof ApiError && err.status === 429
          ? "Too many judges from this network right now. Try again in an hour."
          : (err as Error).message,
      );
      setBusy(false);
    }
  }
  return (
    <AppShell nav={NAV} account={null}>
      <div className={cn("grid gap-6", pending && "pending-session")}>
        <div className="grid max-w-3xl gap-2">
          <h1 className="font-semibold text-[1.75rem] leading-[1.1] tracking-[-0.025em]">
            Judge Mode
          </h1>
          <p className="text-pretty text-lg text-muted-foreground leading-snug">
            Ten steps on the live sandbox. No keys, no sign-up.
          </p>
        </div>
        <section
          aria-label="Start"
          className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-3xl border bg-card p-5 sm:p-6"
        >
          <span className="flex gap-1.5" aria-hidden="true">
            {ROLES.map((r) => (
              <span
                key={r}
                className="grid size-10 place-items-center rounded-xl bg-bone-2 font-medium text-sm"
              >
                {r.charAt(0)}
              </span>
            ))}
          </span>
          <span className="grid min-w-0 flex-1 leading-snug">
            <span className="font-semibold">Shopper, merchant, operator</span>
            <span className="text-muted-foreground text-sm">
              A temporary tenant that closes within a day.
              {signedIn ? " This signs you out first." : ""}
            </span>
          </span>
          <Button size="lg" onClick={start} disabled={busy || pending}>
            {busy ? "Opening your tenant…" : "Start Judge Mode"}
          </Button>
        </section>
        {problem ? <ErrorNotice>{problem}</ErrorNotice> : null}
        <Panel title="Real or sandbox">
          <EnvironmentTable />
        </Panel>
      </div>
    </AppShell>
  );
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Walkthrough({ tour }: { tour: Tour }) {
  const [step, setStep] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [started, setStarted] = useState(() => Date.now());
  useEffect(() => {
    const saved = Number(localStorage.getItem(STEP_KEY));
    if (Number.isInteger(saved) && saved >= 0 && saved < STEPS.length) setStep(saved);
    const at = Number(localStorage.getItem(STARTED_KEY));
    if (at > 0) setStarted(at);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const go = (n: number) => {
    setStep(n);
    localStorage.setItem(STEP_KEY, String(n));
    document.getElementById("step-title")?.focus();
  };
  const current = STEPS[step] as (typeof STEPS)[number];
  const inRole = STEPS.map((x, i) => ({ ...x, i })).filter((x) => x.role === current.role);
  const exit = () =>
    authClient.signOut().then(() => {
      localStorage.removeItem(STEP_KEY);
      localStorage.removeItem(STARTED_KEY);
      location.assign("/judge/");
    });

  return (
    <AppShell
      nav={NAV}
      account={{ name: "Judge", detail: "Temporary tenant", onSignOut: () => void exit() }}
    >
      <div className="grid gap-6">
        <section aria-label="Judge Mode" className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <fieldset className="flex gap-1 rounded-xl bg-bone-2 p-1">
            <legend className="sr-only">Viewing as</legend>
            {ROLES.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={current.role === r}
                onClick={() => go(STEPS.findIndex((x) => x.role === r))}
                className="h-9 rounded-lg px-3.5 text-sm aria-pressed:bg-card aria-pressed:font-medium aria-pressed:shadow-[0_1px_3px_rgb(23_24_27/0.12)]"
              >
                {r}
              </button>
            ))}
          </fieldset>
          <span className="ml-auto font-mono text-muted-foreground text-sm tnum">
            {step + 1}/{STEPS.length} · {elapsed(now - started)}
          </span>
          <button
            type="button"
            className="h-9 rounded-lg px-3 text-muted-foreground text-sm hover:bg-foreground/5 hover:text-foreground"
            onClick={() => void exit()}
          >
            Exit
          </button>
        </section>

        <nav aria-label="Tour steps">
          <ol className="flex gap-1.5">
            {inRole.map((x) => (
              <li key={x.id} className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => go(x.i)}
                  aria-current={x.i === step ? "step" : undefined}
                  className="group grid w-full gap-2 py-1 text-left"
                >
                  <span
                    className={`block h-1 rounded-full transition-colors ${x.i < step ? "bg-foreground" : x.i === step ? "bg-vermilion" : "bg-foreground/12 group-hover:bg-foreground/25"}`}
                  />
                  <span
                    className={`truncate text-xs ${x.i === step ? "font-medium text-foreground" : "text-muted-foreground"} ${x.i === step ? "" : "sr-only sm:not-sr-only"}`}
                  >
                    {x.title}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <section aria-labelledby="step-title" className="grid content-start gap-6">
          <div className="grid max-w-3xl gap-2">
            <h1
              id="step-title"
              tabIndex={-1}
              className="text-balance font-semibold text-[1.75rem] leading-[1.1] tracking-[-0.025em] outline-none"
            >
              {current.title}
            </h1>
            <p className="text-pretty text-lg text-muted-foreground leading-snug">{current.line}</p>
          </div>
          <StepBody id={current.id} tour={tour} />
          <div className="flex items-center justify-between gap-3 border-t pt-5">
            <Button variant="ghost" onClick={() => go(step - 1)} disabled={step === 0}>
              Back
            </Button>
            {step < STEPS.length - 1 ? (
              <Button onClick={() => go(step + 1)}>
                Next: {(STEPS[step + 1] as (typeof STEPS)[number]).title}
              </Button>
            ) : (
              <Button asChild>
                <Link href="/new/">Sign your own mandate</Link>
              </Button>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}

function StepBody({ id, tour }: { id: string; tour: Tour }) {
  const purchases = tour.mandate?.purchases ?? [];
  const captured = purchases.find((p) => p.state === "CAPTURED");
  const blocked = purchases.find((p) => p.state === "DENIED");
  switch (id) {
    case "mandate":
      return <MandateStep tour={tour} />;
    case "agent":
      return <AgentStep captured={captured} blocked={blocked} />;
    case "alibi":
      return <AlibiStep captured={captured} />;
    case "anonymous":
      return <AnonymousStep purchase={tour.anonymous_purchase} />;
    case "equivocation":
      return <EquivocationStep />;
    case "dispute":
    case "verdict":
      return <DisputeStep id={tour.dispute_id} part={id} />;
    case "forensics":
      return <ForensicsStep />;
    case "grade":
      return <GradeStep agentId={tour.agent_id} />;
    case "scoreboard":
      return <ScoreboardStep campaign={tour.campaign_id} />;
    default:
      return <StatusStep />;
  }
}

/** The longer explanation, folded under the step's one line. */
function Lead({ children }: { children: React.ReactNode }) {
  return (
    <details className="w-fit max-w-prose">
      <summary className="cursor-pointer list-none py-1 font-medium text-sm underline-offset-4 hover:underline">
        How this works
      </summary>
      <p className="mt-2 text-pretty text-muted-foreground text-sm leading-relaxed">{children}</p>
    </details>
  );
}

function Missing({ what }: { what: string }) {
  return <ErrorNotice>No {what} on this deployment yet.</ErrorNotice>;
}

function MandateStep({ tour }: { tour: Tour }) {
  const m = tour.mandate;
  if (!m?.card) return <Missing what="agent purchase" />;
  return (
    <div className="grid gap-6">
      <Lead>
        A shopper wrote one sentence; Keelson compiled it into this card and the shopper signed it
        with a passkey. Each field says who answers if the agent gets it wrong. This is the mandate
        the demo agent last bought under, signed {when(m.created_at)}.
      </Lead>
      <DataList layout="row" className="max-w-2xl rounded-3xl border bg-card px-5 py-2 sm:px-6">
        <DataItem label="Budget">{money(m.budget.max_minor, m.budget.currency)}</DataItem>
        <DataItem label="Mandate">
          <span className="font-mono text-sm">{m.id}</span>
        </DataItem>
        {m.mandate_hash ? (
          <DataItem label="Passkey signed">
            <span className="font-mono text-sm">{m.mandate_hash.slice(0, 18)}…</span>
          </DataItem>
        ) : null}
      </DataList>
      <MandateCard card={m.card} />
      <LiabilityLegend />
    </div>
  );
}

function checksFailed(p: TourPurchase): string {
  const failed = p.checks.filter((c) => !c.pass).map((c) => c.field.replaceAll("_", " "));
  return failed.length > 0 ? failed.join(", ") : "none";
}

function AgentStep({
  captured,
  blocked,
}: {
  captured: TourPurchase | undefined;
  blocked: TourPurchase | undefined;
}) {
  if (!captured) return <Missing what="captured purchase" />;
  return (
    <div className="grid gap-6">
      <Lead>
        The shopping agent ran twice under that mandate on the RunFast store, in a cloud browser.
        Once on a listing where we planted a prompt injection, once on the clean store. Both carts
        went to Keelson&apos;s two TEEs before PayPal took any money.
      </Lead>
      <div className="grid gap-4 lg:grid-cols-2">
        {blocked ? (
          <article className="grid content-start gap-4 rounded-3xl border border-vermilion/35 bg-vermilion/[0.06] p-5 sm:p-6">
            <div className="flex items-center gap-3.5">
              <Mark kind="blocked" />
              <span className="grid flex-1 leading-tight">
                <h2 className="font-semibold">Injected listing</h2>
                <span className="text-muted-foreground text-sm">Blocked · nothing paid</span>
              </span>
            </div>
            <Amount
              value={Number(blocked.amount.minor) / 100}
              currency={blocked.amount.currency}
              className="text-[2.25rem]"
              struck="Not paid"
            />
            <DataList>
              <DataItem label="Checks failed">{checksFailed(blocked)}</DataItem>
              <DataItem label="Captured">Nothing</DataItem>
              {blocked.log_index ? (
                <DataItem label="Logged as">entry #{blocked.log_index}</DataItem>
              ) : null}
            </DataList>
          </article>
        ) : null}
        <article className="grid content-start gap-4 rounded-3xl border bg-card p-5 sm:p-6">
          <div className="flex items-center gap-3.5">
            <Mark kind="bought" />
            <span className="grid flex-1 leading-tight">
              <h2 className="font-semibold">Clean store</h2>
              <span className="text-muted-foreground text-sm">Bought · captured on PayPal</span>
            </span>
          </div>
          <Amount
            value={Number(captured.amount.minor) / 100}
            currency={captured.amount.currency}
            className="text-[2.25rem]"
          />
          <DataList>
            <DataItem label="Countersigned">
              {captured.mode === "2of2" ? "By both TEEs (2 of 2)" : (captured.mode ?? "—")}
            </DataItem>
            {captured.capture_id ? (
              <DataItem label="PayPal capture">
                <span className="font-mono text-sm">{captured.capture_id}</span>
              </DataItem>
            ) : null}
            {captured.coverage_tx ? (
              <DataItem label="Bond coverage">
                <a
                  className="font-mono text-sm underline"
                  href={`https://sepolia.arbiscan.io/tx/${captured.coverage_tx}`}
                  target="_blank"
                  rel="noopener"
                >
                  {captured.coverage_tx.slice(0, 12)}… ↗
                </a>
              </DataItem>
            ) : null}
            {captured.log_index ? (
              <DataItem label="Logged as">entry #{captured.log_index}</DataItem>
            ) : null}
          </DataList>
        </article>
      </div>
      <p className="text-muted-foreground text-sm">
        Your own runs show the agent&apos;s browser live, read-only, on the mandate page.
      </p>
    </div>
  );
}

function AlibiStep({ captured }: { captured: TourPurchase | undefined }) {
  if (!captured) return <Missing what="Alibi" />;
  return (
    <div className="grid gap-5">
      <Lead>
        The purchase left an Alibi: a receipt anyone can check without trusting us. Swap the cart,
        blame another agent or fake the on-chain anchor, and watch which check catches it.
      </Lead>
      <iframe
        title="Alibi verifier"
        src={`${VERIFY}/a/${captured.id}?embed${captured.alibi_fragment ? `#${captured.alibi_fragment}` : ""}`}
        loading="lazy"
        className="h-[34rem] w-full rounded-3xl border bg-card"
      />
      <a
        className="text-sm underline"
        href={`${VERIFY}/a/${captured.id}${captured.alibi_fragment ? `#${captured.alibi_fragment}` : ""}`}
        target="_blank"
        rel="noopener"
      >
        Open in the full verifier ↗
      </a>
    </div>
  );
}

function AnonymousStep({ purchase }: { purchase: Tour["anonymous_purchase"] }) {
  if (!purchase) return <Missing what="purchase with an anonymous proof" />;
  const link = `${VERIFY}/a/${purchase.id}?proof=anonymous${purchase.alibi_fragment ? `#${purchase.alibi_fragment}` : ""}`;
  return (
    <div className="grid gap-5">
      <Lead>
        A merchant can know a real, registered person approved this purchase and that the cart
        stayed within their mandate, without learning who they are. One zero-knowledge proof carries
        both. Your browser verifies it below, then asks the verifier on Arbitrum.
      </Lead>
      <iframe
        title="Anonymous proof verifier"
        src={link.replace("?proof=anonymous", "?embed&proof=anonymous")}
        loading="lazy"
        className="h-[42rem] w-full rounded-3xl border bg-card"
      />
      <a className="text-sm underline" href={link} target="_blank" rel="noopener">
        Open in the full verifier ↗
      </a>
    </div>
  );
}

function EquivocationStep() {
  return (
    <div className="grid gap-5">
      <Lead>
        Every Alibi sits in a public log. If the log ever signed two different histories of the same
        size, those two checkpoints are proof, and they slash the bond on its key: a bounty to
        whoever submits them, the rest to Keelson&apos;s reserve. The contract checks both Ed25519
        signatures itself; no one at Keelson is asked. Below is a real slash on Arbitrum Sepolia,
        from our drill on a test origin.
      </Lead>
      <LogBonds />
    </div>
  );
}

const PARTY = {
  operator: "The agent's operator",
  keelson: "Keelson",
  merchant: "The merchant",
  user: "The shopper",
} as const;

const PAID_BY = {
  chain: "On chain, from the bond or reserve",
  treasury: "Keelson's treasury",
  "violation-pool": "The operator's violation pool",
} as const;

function DisputeStep({ id, part }: { id: string | null; part: "dispute" | "verdict" }) {
  const [d, setD] = useState<DisputeStatus | { error: string }>();
  useEffect(() => {
    if (id) disputeOf(id).then(setD, (e: Error) => setD({ error: e.message }));
  }, [id]);
  if (!id) return <Missing what="dispute" />;
  if (!d) return <p className="text-muted-foreground">Reading the dispute…</p>;
  if ("error" in d) return <ErrorNotice>{d.error}</ErrorNotice>;
  if (part === "dispute") {
    return (
      <div className="grid gap-6">
        <Lead>
          The buyer opened a dispute in PayPal&apos;s sandbox. Keelson received it, read the
          purchase&apos;s Alibi and attributed fault. This dispute was opened ahead of time, so the
          tour skips PayPal&apos;s few minutes of delivery lag; its id is real.
        </Lead>
        <DataList layout="row" className="max-w-2xl rounded-3xl border bg-card px-5 py-2 sm:px-6">
          <DataItem label="PayPal dispute">
            <span className="font-mono text-sm">{d.dispute_id}</span>
          </DataItem>
          <DataItem label="Reason">{d.reason.replaceAll("_", " ").toLowerCase()}</DataItem>
          <DataItem label="Purchase">
            <span className="font-mono text-sm">{d.purchase_id}</span>
          </DataItem>
          <DataItem label="State">{d.state.toLowerCase()}</DataItem>
        </DataList>
        <Timeline className="max-w-xl">
          <TimelineItem
            state="done"
            actor="PayPal"
            {...(d.received_at ? { time: d.received_at } : {})}
          >
            Dispute delivered to Keelson
          </TimelineItem>
          <TimelineItem
            state={d.attributed_at ? "done" : "current"}
            actor="Keelson's two TEEs"
            {...(d.attributed_at ? { time: d.attributed_at } : {})}
          >
            Fault attributed
            {d.elapsed_ms !== null ? ` in ${(d.elapsed_ms / 1000).toFixed(1)} s` : ""}
          </TimelineItem>
        </Timeline>
      </div>
    );
  }
  const s = d.settlement;
  return (
    <div className="grid gap-6">
      <Lead>
        The verdict names who pays and under which rule, signed by both TEEs. Settlement follows it:
        the operator&apos;s bond, Keelson&apos;s reserve, or nobody when the merchant is at fault.
        PayPal still decides the dispute; Keelson brings the evidence.
      </Lead>
      <DataList layout="row" className="max-w-2xl rounded-3xl border bg-card px-5 py-2 sm:px-6">
        <DataItem label="At fault">{d.liable ? PARTY[d.liable] : "Not yet"}</DataItem>
        {d.verdict ? (
          <>
            <DataItem label="Rule">
              <span className="font-mono">{d.verdict.rule}</span>
            </DataItem>
            <DataItem label="Signed by">{d.verdict.signatures.length} TEE legs</DataItem>
          </>
        ) : null}
        {s ? (
          <>
            <DataItem label="Paid by">{s.paid_by ? PAID_BY[s.paid_by] : "—"}</DataItem>
            <DataItem label="Outcome">{s.outcome ?? "pending"}</DataItem>
            <DataItem label="Rail">
              {s.rail === "pyusd" ? "PYUSD on chain" : "PayPal Payout"}
            </DataItem>
            {s.refund_id ? (
              <DataItem label="Buyer refund">
                <span className="font-mono text-sm">{s.refund_id}</span>
              </DataItem>
            ) : null}
            {s.explorer_url ? (
              <DataItem label="Transaction">
                <a className="underline" href={s.explorer_url} target="_blank" rel="noopener">
                  Arbiscan ↗
                </a>
              </DataItem>
            ) : null}
          </>
        ) : null}
      </DataList>
      {d.amber ? (
        <AmberCase amber={d.amber} purchaseId={d.purchase_id} className="max-w-2xl" />
      ) : null}
    </div>
  );
}

function ForensicsStep() {
  return (
    <div className="grid gap-5">
      <Lead>
        The merchant&apos;s console holds every dispute over agent purchases with its verdict, and a
        field-by-agent matrix of which mandate checks each agent fails. You open it as the demo
        merchant, read only: the settlement wallet&apos;s key stays with the merchant. Ask its
        assistant &ldquo;Why did we lose our latest dispute, and which agents fail most on
        price?&rdquo;.
      </Lead>
      <div className="flex flex-wrap items-center gap-4">
        <Button asChild>
          <Link href="/merchant/">Open the merchant console</Link>
        </Button>
        <span className="text-muted-foreground text-sm">
          The assistant runs on Claude with a small budget for this session.
        </span>
      </div>
    </div>
  );
}

function GradeStep({ agentId }: { agentId: string | null }) {
  const [g, setG] = useState<Grade | { error: string }>();
  useEffect(() => {
    if (agentId) gradeOf(agentId).then(setG, (e: Error) => setG({ error: e.message }));
  }, [agentId]);
  if (!agentId) return <Missing what="demo operator" />;
  if (!g) return <p className="text-muted-foreground">Reading the grade…</p>;
  if ("error" in g) return <ErrorNotice>{g.error}</ErrorNotice>;
  return (
    <div className="grid gap-6">
      <Lead>
        The operator behind the agent posts a bond. Its grade comes from the red team&apos;s attack
        rates and its own covered purchases, and prices the premium it pays on each coverage.
      </Lead>
      <div className="flex items-center gap-4">
        <span className="grid size-16 shrink-0 place-items-center rounded-2xl bg-graphite font-mono font-semibold text-4xl text-bone">
          {g.grade}
        </span>
        <span className="text-muted-foreground">
          Agent #{g.agentId} · incidents at most {percent(g.frequency.upper95_ppm, true)} (95 %
          upper bound)
        </span>
      </div>
      <DataList layout="row" className="max-w-2xl rounded-3xl border bg-card px-5 py-2 sm:px-6">
        <DataItem label="Covered purchases">
          {g.evidence.coverages.toLocaleString("en-US")}
        </DataItem>
        <DataItem label="Incidents at fault">{g.evidence.incidents.total}</DataItem>
        <DataItem label="Premium">{g.premium.bps} bps per coverage</DataItem>
        <DataItem label="Minimum bond">{money(String(g.bond.requiredMinor), "USD")}</DataItem>
        <DataItem label="Computed">{when(g.computedAt)}</DataItem>
      </DataList>
    </div>
  );
}

function ScoreboardStep({ campaign }: { campaign: string | null }) {
  const [s, setS] = useState<Scoreboard | { error: string }>();
  useEffect(() => {
    if (campaign) scoreboard(campaign).then(setS, (e: Error) => setS({ error: e.message }));
  }, [campaign]);
  if (!campaign) return <Missing what="finished campaign" />;
  if (!s) return <p className="text-muted-foreground">Reading the scoreboard…</p>;
  if ("error" in s) return <ErrorNotice>{s.error}</ErrorNotice>;
  const all = s.rows.filter((r) => r.split === "all" && r.backbone !== "all");
  return (
    <div className="grid gap-6">
      <Lead>
        We attack our own agent continuously. {s.attacks.toLocaleString("en-US")} attacks in the
        latest campaign; every attempt is in a hash-chained ledger you can download and recompute.
      </Lead>
      <div className="grid gap-3 sm:grid-cols-2">
        {all.map((r) => (
          <article key={r.backbone} className="grid gap-2 rounded-3xl border bg-card p-5 sm:p-6">
            <h2 className="font-medium">{r.backbone} agent</h2>
            <p className="text-muted-foreground text-sm">
              Hijacked {r.asr.k} of {r.asr.n} times.{" "}
              {r.escape.n === 0 ? (
                "It never proposed a cart that breaks the mandate."
              ) : (
                <>
                  Bad carts that got past Keelson:{" "}
                  <span className="font-mono text-foreground">
                    {r.escape.k} of {r.escape.n}
                  </span>{" "}
                  (at most {percent(r.escape.hi_ppm, true)}).
                </>
              )}
            </p>
          </article>
        ))}
      </div>
      <Link href="/scoreboard/" className="text-sm underline">
        Open the scoreboard and its methodology
      </Link>
    </div>
  );
}

function StatusStep() {
  const [r, setR] = useState<StatusReport | { error: string }>();
  useEffect(() => {
    statusReport().then(setR, (e: Error) => setR({ error: e.message }));
  }, []);
  return (
    <div className="grid gap-6">
      <Lead>
        Everything you just saw runs right now. This is the live health of each dependency and the
        environment it runs in.
      </Lead>
      {!r ? (
        <p className="text-muted-foreground">Reading the status…</p>
      ) : "error" in r ? (
        <ErrorNotice>{r.error}</ErrorNotice>
      ) : (
        <HealthList report={r} />
      )}
      <Link href="/status/" className="text-sm underline">
        Open the status page
      </Link>
    </div>
  );
}
