"use client";

import {
  type PasskeyRef,
  prepareSigning,
  type Signing,
  signMandate,
} from "@keelson/mandate/browser";
import { Button } from "@keelson/ui/components/button";
import { Ban, Check, Fingerprint, Hand, Loader2, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError, get, post } from "../lib/api";
import type { ConnectionView } from "../lib/connections";
import { untilIn } from "../lib/connections";
import { deviceId } from "../lib/device";
import { money } from "../lib/format";
import type { Compiled } from "../lib/types";
import { MandateVisual } from "./mandate-visual";
import { ErrorNotice } from "./notice";
import { OnboardingFrame } from "./onboarding/frame";
import { PasskeySetup } from "./passkey-setup";

const NO_EVIDENCE = { merchantSignedCheckout: false, zkTlsFields: new Set<never>() };
const HOUR = 3_600_000;

const day = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));

/** What the user grants: never above what the agent asked. */
interface Chosen {
  perPurchase: number;
  total: number;
  askAbove: number | null;
  merchants: string[];
  until: string;
}

function asked(c: ConnectionView): Chosen {
  return {
    perPurchase: Number(c.limits.perPurchaseMinor),
    total: Number(c.limits.totalMinor),
    askAbove: c.limits.askAboveMinor === null ? null : Number(c.limits.askAboveMinor),
    merchants: c.limits.merchants.map((m) => m.id),
    until: c.limits.until,
  };
}

function message(e: unknown): string {
  if (e instanceof DOMException && e.name === "NotAllowedError") {
    return "The passkey prompt was closed. Nothing was approved.";
  }
  return e instanceof Error ? e.message : "Something went wrong.";
}

/** A sentence of the grant with its value chip and what Keelson does past it. */
function Clause({
  consequence,
  children,
  control,
}: {
  consequence: "block" | "ask";
  children: ReactNode;
  control?: ReactNode;
}) {
  return (
    <li className="grid gap-2.5 py-3.5">
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-bone-2"
          title={consequence === "block" ? "Keelson refuses past this" : "Paused for you past this"}
        >
          {consequence === "block" ? (
            <Ban className="size-3.5" aria-hidden="true" />
          ) : (
            <Hand className="size-3.5" aria-hidden="true" />
          )}
          <span className="sr-only">
            {consequence === "block" ? "Keelson refuses past this." : "Paused for you past this."}
          </span>
        </span>
        <p className="flex-1 text-pretty leading-relaxed">{children}</p>
      </div>
      {control ? <div className="pl-10">{control}</div> : null}
    </li>
  );
}

function Value({ children }: { children: ReactNode }) {
  return (
    <span className="mx-0.5 inline-block rounded-md bg-graphite px-1.5 py-0.5 font-medium text-bone text-sm tnum">
      {children}
    </span>
  );
}

/** A slider that only goes down from what was asked. */
function Lower({
  label,
  value,
  max,
  currency,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  currency: string;
  onChange: (v: number) => void;
}) {
  const id = useId();
  const min = Math.min(100, max);
  const step = max >= 1_000 ? 100 : 1;
  return (
    <div className="grid gap-1">
      <input
        id={id}
        type="range"
        aria-label={label}
        aria-valuetext={money(BigInt(value), currency)}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Math.min(max, Number(e.target.value)))}
        className="range w-full"
        style={
          {
            "--p": `${max > min ? ((value - min) / (max - min)) * 100 : 100}%`,
          } as React.CSSProperties
        }
      />
      <span className="text-muted-foreground text-xs tnum">
        Asked {money(BigInt(max), currency)}
        {value < max ? ` · you lowered it by ${money(BigInt(max - value), currency)}` : ""}
      </span>
    </div>
  );
}

export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-bone-2 px-2.5 text-foreground text-xs">
      {children}
    </span>
  );
}

/**
 * The one place a user approves what an agent asks for, reached from the agent's link, an app's
 * consent or a chat card: the request in the agent's words, its limits as sentences the user may
 * only lower, and a passkey over the mandate that grants exactly that. `onApproved` continues an
 * OAuth consent; without it the page restates the grant and goes on to the PayPal hold.
 */
export function Approval({
  request,
  onApproved,
  onDeclined,
  continueLabel,
}: {
  request: ConnectionView;
  onApproved?: (mandateId: string) => void;
  onDeclined?: () => void;
  /** Where approval leads when `onApproved` takes over, e.g. "Back to Inspector". */
  continueLabel?: string;
}) {
  const once = request.kind === "once";
  const { currency } = request.limits;
  const [chosen, setChosen] = useState<Chosen>(() => asked(request));
  const [signing, setSigning] = useState<{ for: Chosen; signing: Signing; compiled: Compiled }>();
  const [phase, setPhase] = useState<"review" | "passkey" | "signing" | "approved" | "declined">(
    "review",
  );
  const [needsPasskey, setNeedsPasskey] = useState(false);
  const [error, setError] = useState<string>();
  const [mandate, setMandate] = useState<{ id: string; state: string }>();
  const [now, setNow] = useState(() => Date.now());
  const drafting = useRef(0);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // The draft follows the chosen limits, so the passkey prompt opens on the click.
  const draft = useCallback(
    async (c: Chosen) => {
      const n = ++drafting.current;
      try {
        const compiled = await post<Compiled>(
          `/v1/connections/${request.code}/draft`,
          {
            limits: {
              perPurchaseMinor: c.perPurchase,
              totalMinor: c.total,
              merchants: c.merchants,
              until: c.until,
              ...(c.askAbove === null ? {} : { askAboveMinor: c.askAbove }),
            },
          },
          { "keelson-device": deviceId() },
        );
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const signing = await prepareSigning(
          compiled.mandateDraft,
          salt,
          NO_EVIDENCE,
          compiled.ambiguous,
        );
        if (n === drafting.current) {
          setSigning({ for: c, signing, compiled });
          setError(undefined);
        }
      } catch (e) {
        if (n !== drafting.current) return;
        if (e instanceof ApiError && e.slug === "passkey-required") setNeedsPasskey(true);
        else setError(message(e));
      }
    },
    [request.code],
  );

  useEffect(() => {
    const t = setTimeout(() => void draft(chosen), 350);
    return () => clearTimeout(t);
  }, [chosen, draft]);

  const ready = signing !== undefined && signing.for === chosen;
  const cap = money(BigInt(chosen.total), currency);
  const merchantNames = request.limits.merchants
    .filter((m) => chosen.merchants.includes(m.id))
    .map((m) => m.name);

  const approve = async () => {
    if (needsPasskey) {
      setPhase("passkey");
      return;
    }
    if (!signing || !ready) return;
    setPhase("signing");
    setError(undefined);
    try {
      const { passkeys } = await get<{ passkeys: PasskeyRef[] }>("/v1/passkeys");
      const s = signing.signing;
      const assertion = await signMandate(s.challenge, passkeys, { spc: s.spc });
      const created = await post<{ id: string; state: string }>("/v1/mandates", {
        payloadSd: s.payloadSd,
        disclosures: s.disclosures,
        commitment: s.commitment,
        salt: s.salt,
        assertion,
        connection: {
          code: request.code,
          ...(chosen.askAbove === null ? {} : { askAboveMinor: chosen.askAbove }),
        },
      });
      setMandate(created);
      setPhase("approved");
      onApproved?.(created.id);
    } catch (e) {
      setError(message(e));
      setPhase("review");
    }
  };

  const decline = async () => {
    setError(undefined);
    try {
      await post(`/v1/connections/${request.code}/deny`);
      setPhase("declined");
      onDeclined?.();
    } catch (e) {
      setError(message(e));
    }
  };

  if (phase === "passkey") {
    return (
      <PasskeySetup
        onBack={() => setPhase("review")}
        onDone={() => {
          setNeedsPasskey(false);
          setPhase("review");
          void draft(chosen);
        }}
      />
    );
  }

  const grantLine = `${request.name} can spend up to ${cap}${merchantNames.length ? ` at ${merchantNames.join(", ")}` : ""} until ${day(chosen.until)}.`;
  const stage = (
    <div className="grid w-full max-w-[440px] gap-4">
      <MandateVisual
        amount={chosen.total / 100}
        currency={currency}
        amountLabel={once ? "This cart" : "Up to"}
        what={once ? "One cart, nothing else" : "Any item at the stores allowed"}
        chips={merchantNames.length ? merchantNames : ["No store"]}
        until={day(chosen.until)}
        state={phase === "approved" ? "Approved" : once ? "Paused" : "Requested"}
        seal={phase === "approved" ? "closed" : ready ? "closing" : "open"}
      />
      <div className="grid gap-1 rounded-2xl bg-card px-4 py-3 text-sm">
        <span className="font-medium">{request.name}</span>
        <span className="text-muted-foreground">
          Run by {request.agent.operator}, registered agent #{request.agent.agentId}
        </span>
      </div>
    </div>
  );

  if (phase === "approved" && mandate) {
    const held = mandate.state === "ACTIVE";
    return (
      <OnboardingFrame
        step="Agent"
        stage={stage}
        stageLabel="The mandate you approved"
        action={
          onApproved ? (
            <p role="status" className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {continueLabel ?? "Returning"}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Button asChild size="lg" variant="outline" className="h-13 rounded-xl">
                <Link href="/agents/">See your agents</Link>
              </Button>
              <Button asChild size="lg" className="h-13 rounded-xl text-base">
                <Link href={held ? "/" : `/new/?hold=${mandate.id}`}>
                  {held ? "Go home" : `Hold ${cap} on PayPal`}
                </Link>
              </Button>
            </div>
          )
        }
      >
        <h1 className="flex items-center gap-3 text-balance font-semibold text-[1.75rem] leading-[1.1] tracking-[-0.025em] sm:text-[2rem]">
          <span className="grid size-9 place-items-center rounded-full bg-ok text-bone">
            <Check className="size-5" strokeWidth={2.5} aria-hidden="true" />
          </span>
          Approved
        </h1>
        <p className="mt-3 text-pretty text-lg leading-snug">
          {once
            ? `${request.name} can buy this one cart for ${cap}${merchantNames.length ? ` at ${merchantNames[0]}` : ""}, and nothing else.`
            : grantLine}{" "}
          <span className="text-muted-foreground">Revoke it any time.</span>
        </p>
      </OnboardingFrame>
    );
  }

  if (phase === "declined") {
    return (
      <OnboardingFrame
        step="Agent"
        stage={stage}
        action={
          onDeclined ? null : (
            <Button asChild size="lg" variant="outline" className="h-13 w-full rounded-xl">
              <Link href="/">Go home</Link>
            </Button>
          )
        }
      >
        <h1 className="text-balance font-semibold text-[1.75rem] leading-[1.1] tracking-[-0.025em] sm:text-[2rem]">
          Declined
        </h1>
        <p className="mt-3 text-pretty text-lg text-muted-foreground leading-snug">
          {request.name} was told no and may not spend. Nothing was signed.
        </p>
      </OnboardingFrame>
    );
  }

  const parentLeft = request.parent ? Number(request.parent.remainingMinor) : 0;
  const parentPer = request.parent ? Number(request.parent.perPurchaseMinor) : 0;
  const over = Math.max(0, chosen.total - Math.min(parentLeft, parentPer || parentLeft));
  const set = (patch: Partial<Chosen>) => setChosen((c) => ({ ...c, ...patch }));
  const requested = asked(request);
  const untilOptions = [
    { id: "asked", label: "As asked", at: requested.until },
    ...[
      { id: "day", label: "24 hours", ms: 24 * HOUR },
      { id: "hour", label: "1 hour", ms: HOUR },
    ]
      .map((o) => ({ ...o, at: new Date(now + o.ms).toISOString() }))
      .filter((o) => Date.parse(o.at) < Date.parse(requested.until)),
  ];
  const signingNow = phase === "signing";

  return (
    <OnboardingFrame
      step="Agent"
      stage={stage}
      stageLabel="The mandate you would approve"
      action={
        <div className="grid grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
          <Button
            size="lg"
            variant="outline"
            onClick={decline}
            disabled={signingNow}
            className="h-13 rounded-xl px-5"
          >
            {once ? "Decline" : "Reject"}
          </Button>
          <Button
            size="lg"
            onClick={approve}
            disabled={signingNow || (!ready && !needsPasskey) || chosen.merchants.length === 0}
            className="h-13 rounded-xl px-4 text-[15px] sm:text-base"
          >
            {signingNow || (!ready && !needsPasskey && !error) ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Fingerprint aria-hidden="true" />
            )}
            {signingNow
              ? "Waiting for your passkey"
              : once
                ? `Approve once · ${cap}`
                : `Approve ${cap} with passkey`}
          </Button>
        </div>
      }
    >
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip>Expires in {untilIn(request.expiresAt, now)}</Chip>
          <Chip>
            Code <span className="font-mono tracking-wider">{request.code}</span>
          </Chip>
        </div>
        <h1 className="text-balance font-semibold text-[1.75rem] leading-[1.1] tracking-[-0.025em] sm:text-[2rem]">
          {once
            ? `${request.name} wants ${cap}`
            : `${request.name} wants to spend up to ${money(BigInt(requested.total), currency)}`}
        </h1>
        <p className="text-pretty text-muted-foreground leading-snug">
          {once
            ? over > 0
              ? `${money(BigInt(over), currency)} above this mandate. Paused until you answer.`
              : "At a store this mandate does not allow. Paused until you answer."
            : "Only continue if you started this."}
        </p>
      </div>

      {once ? null : (
        <figure className="mt-5 grid gap-1.5">
          <figcaption className="sr-only">In the agent's words</figcaption>
          <blockquote className="max-h-40 overflow-y-auto rounded-xl bg-bone-2 px-3.5 py-3 font-mono text-[13px] leading-relaxed">
            {request.reason}
          </blockquote>
        </figure>
      )}

      <section aria-labelledby="permissions" className="mt-5">
        <h2 id="permissions" className="font-semibold">
          {once ? "What you approve" : "Requested permissions"}
        </h2>
        <ul className="divide-y">
          {once ? (
            <Clause consequence="block">
              This cart only: <Value>{cap}</Value> at <Value>{merchantNames[0]}</Value>, within 15
              minutes.
            </Clause>
          ) : (
            <>
              <Clause
                consequence="block"
                control={
                  <Lower
                    label="Most for one purchase"
                    value={chosen.perPurchase}
                    max={requested.perPurchase}
                    currency={currency}
                    onChange={(v) =>
                      set({
                        perPurchase: v,
                        askAbove: chosen.askAbove === null ? null : Math.min(chosen.askAbove, v),
                      })
                    }
                  />
                }
              >
                Up to <Value>{money(BigInt(chosen.perPurchase), currency)}</Value> per purchase
              </Clause>
              <Clause
                consequence="block"
                control={
                  <Lower
                    label="Most in total"
                    value={chosen.total}
                    max={requested.total}
                    currency={currency}
                    onChange={(v) =>
                      set({ total: v, perPurchase: Math.min(chosen.perPurchase, v) })
                    }
                  />
                }
              >
                <Value>{money(BigInt(chosen.total), currency)}</Value> in total
              </Clause>
              <Clause
                consequence="ask"
                control={
                  <Lower
                    label="Ask me above"
                    value={chosen.askAbove ?? chosen.perPurchase}
                    max={Math.min(requested.askAbove ?? chosen.perPurchase, chosen.perPurchase)}
                    currency={currency}
                    onChange={(v) => set({ askAbove: v })}
                  />
                }
              >
                Ask me before any purchase above{" "}
                <Value>{money(BigInt(chosen.askAbove ?? chosen.perPurchase), currency)}</Value>
              </Clause>
              <Clause
                consequence="block"
                control={
                  <fieldset className="flex flex-wrap gap-1.5">
                    <legend className="sr-only">Stores</legend>
                    {request.limits.merchants.map((m) => (
                      <label
                        key={m.id}
                        className="flex h-9 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm has-checked:border-foreground has-focus-visible:outline-2 has-focus-visible:outline-ring"
                      >
                        <input
                          type="checkbox"
                          checked={chosen.merchants.includes(m.id)}
                          onChange={(e) =>
                            set({
                              merchants: e.target.checked
                                ? [...chosen.merchants, m.id]
                                : chosen.merchants.filter((x) => x !== m.id),
                            })
                          }
                          className="size-4 accent-[var(--color-graphite)]"
                        />
                        {m.name}
                      </label>
                    ))}
                  </fieldset>
                }
              >
                At {merchantNames.length ? <Value>{merchantNames.join(", ")}</Value> : "no store"}{" "}
                only
              </Clause>
              <Clause
                consequence="block"
                control={
                  <fieldset className="grid auto-cols-fr grid-flow-col gap-1 rounded-xl bg-bone-2 p-1">
                    <legend className="sr-only">Until</legend>
                    {untilOptions.map((o) => (
                      <label
                        key={o.id}
                        className="grid h-9 cursor-pointer place-items-center rounded-lg text-sm transition-colors has-checked:bg-card has-checked:font-medium has-checked:shadow-[0_1px_3px_rgb(23_24_27/0.12)] has-focus-visible:outline-2 has-focus-visible:outline-ring"
                      >
                        <input
                          type="radio"
                          name="until"
                          checked={
                            o.id === "asked"
                              ? chosen.until === requested.until
                              : chosen.until === o.at
                          }
                          onChange={() => set({ until: o.at })}
                          className="sr-only"
                        />
                        {o.label}
                      </label>
                    ))}
                  </fieldset>
                }
              >
                Until <Value>{day(chosen.until)}</Value>
              </Clause>
            </>
          )}
        </ul>
        {once ? null : (
          <p className="text-muted-foreground text-sm">
            You can lower any of these; raising one takes a new request from {request.name}.
            Changing limits never affects purchases already in flight.
          </p>
        )}
      </section>

      <section aria-labelledby="exactly" className="mt-6 grid gap-2">
        <h2 id="exactly" className="font-semibold">
          Here's exactly what {request.name} will be able to do
        </h2>
        <ul className="grid gap-1.5 text-sm">
          <li className="flex gap-2">
            <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {once ? `Buy this one cart for ${cap}.` : grantLine}
          </li>
          {once || chosen.askAbove === null ? null : (
            <li className="flex gap-2">
              <Hand className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              Pause any purchase above {money(BigInt(chosen.askAbove), currency)} until you approve
              it once.
            </li>
          )}
          <li className="flex gap-2">
            <Ban className="mt-0.5 size-4 shrink-0 text-vermilion-deep" aria-hidden="true" />
            Nothing outside these rules: Keelson refuses it before PayPal is charged.
          </li>
          <li className="flex gap-2">
            <Ban className="mt-0.5 size-4 shrink-0 text-vermilion-deep" aria-hidden="true" />
            It never sees your PayPal login.
          </li>
        </ul>
        {request.agent.bond ? (
          <p className="mt-2 flex gap-2 rounded-xl border px-3.5 py-3 text-sm">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              Bond-backed: {request.agent.operator} keeps at least {request.agent.bond.min / 1e6}{" "}
              {request.agent.bond.asset} on chain for the parts of a purchase it vouches for. PayPal
              still decides disputes.
            </span>
          </p>
        ) : null}
      </section>

      {error ? (
        <div className="mt-6">
          <ErrorNotice>{error}</ErrorNotice>
        </div>
      ) : null}
    </OnboardingFrame>
  );
}
