"use client";

import {
  type PasskeyRef,
  prepareSigning,
  type Signing,
  signMandate,
} from "@keelson/mandate/browser";
import { Button } from "@keelson/ui/components/button";
import { Check, Loader2, PenLine } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import { ApiError, get, post } from "../lib/api";
import { authClient } from "../lib/auth";
import { deviceId } from "../lib/device";
import type { Compiled } from "../lib/types";
import { MandateVisual } from "./mandate-visual";
import { ErrorNotice } from "./notice";
import { OnboardingFrame } from "./onboarding/frame";
import { PasskeySetup } from "./passkey-setup";
import { SignSheet } from "./sign-sheet";
import { WhoAnswers } from "./who-answers";

const NO_EVIDENCE = { merchantSignedCheckout: false, zkTlsFields: new Set<never>() };
const IDEAS = [
  "Running shoes, size 10",
  "Dog food, 30 lb bag",
  "Coffee beans, whole",
  "USB-C charger",
];
const PRESETS = [25, 50, 100, 250];
const WINDOWS = [
  { id: "day", label: "Today", days: 0 },
  { id: "week", label: "This week", days: 7 },
  { id: "month", label: "This month", days: 30 },
] as const;
type Window = (typeof WINDOWS)[number]["id"];

const short = (d: Date) =>
  new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(d);

function untilDate(w: Window): Date {
  const d = new Date();
  d.setDate(d.getDate() + (WINDOWS.find((x) => x.id === w)?.days ?? 7));
  return d;
}

function message(e: unknown): string {
  if (e instanceof ApiError && e.fields.length > 0) {
    return `${e.message} Say more about: ${e.fields.join(", ")}.`;
  }
  if (e instanceof DOMException && e.name === "NotAllowedError") {
    return "The passkey prompt was closed. Nothing was signed.";
  }
  return e instanceof Error ? e.message : "Something went wrong.";
}

/** What the compiled card says, in the card's own terms. */
function fromCard(compiled: Compiled) {
  const row = (f: string) => compiled.card.rows.find((r) => r.field === f)?.values;
  const total = row("total")?.[0] ?? row("budget")?.[0];
  const deadline = row("deadline")?.[0];
  return {
    amount: total ? Number.parseFloat(total) : null,
    what: row("items")?.join(", ") ?? row("summary")?.[0] ?? "",
    stores: (row("merchant") ?? []).map((m) => m.split(" (")[0] ?? m),
    until: deadline ? short(new Date(deadline)) : null,
  };
}

const READING = ["Reading your request", "Setting the cap", "Finding who answers"];

/** While the request is read: each part ticks off as the card fills in. */
function Reading() {
  const [done, setDone] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setDone((n) => Math.min(n + 1, READING.length - 1)), 900);
    return () => clearInterval(t);
  }, []);
  return (
    <ul className="grid gap-2 rounded-2xl bg-card px-4 py-3" role="status">
      {READING.map((r, i) => (
        <li key={r} className="flex items-center gap-3 text-sm">
          <span
            className={`grid size-5 place-items-center rounded-full ${i < done ? "bg-foreground text-background" : "border"}`}
          >
            {i < done ? (
              <Check className="size-3" strokeWidth={3} />
            ) : i === done ? (
              <Loader2 className="size-3 animate-spin" />
            ) : null}
          </span>
          <span className={i <= done ? "" : "text-muted-foreground"}>{r}</span>
        </li>
      ))}
    </ul>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="grid gap-2.5">
      <legend className="mb-2.5 font-medium text-sm">{label}</legend>
      <div className="grid auto-cols-fr grid-flow-col gap-1 rounded-xl bg-bone-2 p-1">
        {options.map((o) => (
          <label
            key={o.id}
            className="grid h-10 cursor-pointer place-items-center rounded-lg text-sm transition-colors has-checked:bg-card has-checked:font-medium has-checked:shadow-[0_1px_3px_rgb(23_24_27/0.12)] has-focus-visible:outline-2 has-focus-visible:outline-ring"
          >
            <input
              type="radio"
              name={label}
              value={o.id}
              checked={value === o.id}
              onChange={() => onChange(o.id)}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Label({ children, htmlFor }: { children: string; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="font-medium text-sm">
      {children}
    </label>
  );
}

export function NewMandate() {
  const router = useRouter();
  const session = authClient.useSession();
  const handed = useSearchParams().get("request");
  const [what, setWhat] = useState(handed ?? "");
  const [budget, setBudget] = useState(100);
  const [anyStore, setAnyStore] = useState<"any" | "one">("one");
  const [store, setStore] = useState("");
  const [span, setSpan] = useState<Window>("week");
  const [passkeys, setPasskeys] = useState<PasskeyRef[]>();
  const [compiled, setCompiled] = useState<Compiled>();
  const [signing, setSigning] = useState<Signing>();
  const [phase, setPhase] = useState<"edit" | "reading" | "review" | "passkey">("edit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const ids = { what: useId(), budget: useId(), store: useId() };

  useEffect(() => {
    if (session.isPending) return;
    if (!session.data) {
      router.replace("/");
      return;
    }
    get<{ passkeys: PasskeyRef[] }>("/v1/passkeys")
      .then((r) => setPasskeys(r.passkeys))
      .catch((e) => setError(message(e)));
  }, [session.isPending, session.data, router]);

  const until = untilDate(span);
  const request = useMemo(() => {
    const parts = [what.trim(), `under $${budget}`];
    if (anyStore === "one" && store.trim()) parts.push(`from ${store.trim()}`);
    parts.push(`by ${short(until)}`);
    return parts.filter(Boolean).join(", ");
  }, [what, budget, anyStore, store, until]);

  const check = async () => {
    setPhase("reading");
    setError(undefined);
    try {
      const c = await post<Compiled>(
        "/v1/mandates/compile",
        { prompt: request, mode: "autonomous" },
        { "keelson-device": deviceId() },
      );
      setCompiled(c);
      setPhase("review");
      // Built now, so the passkey prompt opens on the click.
      const salt = crypto.getRandomValues(new Uint8Array(16));
      setSigning(await prepareSigning(c.mandateDraft, salt, NO_EVIDENCE, c.ambiguous));
    } catch (e) {
      setError(message(e));
      setPhase("edit");
    }
  };

  const sign = async (s: Signing) => {
    setBusy(true);
    setError(undefined);
    try {
      const { passkeys } = await get<{ passkeys: PasskeyRef[] }>("/v1/passkeys");
      const assertion = await signMandate(s.challenge, passkeys, { spc: s.spc });
      const created = await post<{ id: string }>("/v1/mandates", {
        payloadSd: s.payloadSd,
        disclosures: s.disclosures,
        commitment: s.commitment,
        salt: s.salt,
        assertion,
      });
      router.push(`/mandate/?id=${created.id}`);
    } catch (e) {
      setError(message(e));
      setBusy(false);
      setConfirming(false);
    }
  };

  const startSigning = () => {
    if (passkeys && passkeys.length === 0) setPhase("passkey");
    else setConfirming(true);
  };

  if (phase === "passkey") {
    return (
      <div className="mx-auto max-w-xl px-5 py-12">
        <PasskeySetup
          onDone={() =>
            get<{ passkeys: PasskeyRef[] }>("/v1/passkeys").then((r) => {
              setPasskeys(r.passkeys);
              setPhase("review");
              setConfirming(true);
            })
          }
        />
      </div>
    );
  }

  const read = compiled && phase === "review" ? fromCard(compiled) : null;
  const card = read ?? {
    amount: budget,
    what: what.trim(),
    stores: anyStore === "one" && store.trim() ? [store.trim()] : [],
    until: short(until),
  };
  const editing = phase === "edit";
  const cap = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    read?.amount ?? budget,
  );

  const stage = (
    <div className="grid w-full max-w-[440px] gap-4">
      <MandateVisual
        amount={card.amount}
        currency="USD"
        amountLabel="Up to"
        what={card.what}
        chips={card.stores.length > 0 ? card.stores : ["Any store"]}
        until={card.until}
        state={read ? "Ready to sign" : "Draft"}
        seal={read ? "closing" : "open"}
      />
      {phase === "reading" ? <Reading /> : null}
      {read && compiled ? <WhoAnswers card={compiled.card} /> : null}
      {read && compiled && compiled.check.status !== "ok" ? (
        <p className="rounded-xl bg-card px-4 py-3 text-sm text-warn">
          Read each part before you sign: the read-back check said {compiled.check.status}.
        </p>
      ) : null}
    </div>
  );

  return (
    <OnboardingFrame
      step="Rules"
      stage={stage}
      stageLabel="Your mandate"
      action={
        editing || phase === "reading" ? (
          <Button
            size="lg"
            onClick={check}
            disabled={phase === "reading" || what.trim() === "" || passkeys === undefined}
            className="h-13 w-full rounded-xl text-base"
          >
            {phase === "reading" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {phase === "reading" ? "Reading" : "Review rules"}
          </Button>
        ) : (
          <div className="grid grid-cols-[auto_1fr] gap-2">
            <Button
              size="lg"
              variant="outline"
              onClick={() => {
                setPhase("edit");
                setCompiled(undefined);
                setSigning(undefined);
              }}
              className="h-13 rounded-xl"
              aria-label="Edit the rules"
            >
              <PenLine aria-hidden="true" />
            </Button>
            <Button
              size="lg"
              disabled={!signing}
              onClick={startSigning}
              className="h-13 rounded-xl text-base"
            >
              {signing ? `Sign · up to ${cap}` : "Preparing"}
            </Button>
          </div>
        )
      }
    >
      <h1 className="text-balance font-semibold text-[1.75rem] leading-[1.1] tracking-[-0.025em] sm:text-[2rem]">
        {phase === "review" ? "Check it, then sign" : "What may your agent buy?"}
      </h1>

      <fieldset
        disabled={!editing}
        className={`mt-6 gap-6 disabled:opacity-60 lg:grid ${phase === "review" ? "hidden" : "grid"}`}
      >
        <div className="grid gap-2.5">
          <textarea
            id={ids.what}
            aria-label="What your agent may buy"
            rows={2}
            maxLength={500}
            value={what}
            onChange={(e) => setWhat(e.target.value)}
            placeholder="Running shoes, size 10"
            className="min-h-[88px] w-full resize-none rounded-2xl border bg-card px-4 py-3.5 text-lg leading-snug outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 focus-visible:border-foreground focus-visible:ring-4 focus-visible:ring-foreground/8"
          />
          <ul className="flex flex-wrap gap-1.5">
            {IDEAS.map((idea) => (
              <li key={idea}>
                <button
                  type="button"
                  onClick={() => setWhat(idea)}
                  aria-pressed={what === idea}
                  className="h-9 rounded-full border px-3.5 text-sm transition-colors hover:bg-foreground/5 aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background"
                >
                  {idea}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="grid gap-3">
          <div className="flex items-baseline justify-between">
            <Label htmlFor={ids.budget}>Spend up to</Label>
            <output htmlFor={ids.budget} className="font-semibold text-2xl tnum tracking-tight">
              ${budget}
            </output>
          </div>
          <input
            id={ids.budget}
            type="range"
            min={5}
            max={500}
            step={5}
            value={budget}
            onChange={(e) => setBudget(Number(e.target.value))}
            className="range"
            style={{ "--p": `${((budget - 5) / 495) * 100}%` } as React.CSSProperties}
          />
          <div className="grid grid-cols-4 gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={budget === p}
                onClick={() => setBudget(p)}
                className="h-9 rounded-lg border text-sm tnum transition-colors hover:bg-foreground/5 aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background"
              >
                ${p}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-2.5">
          <Segmented
            label="Where"
            value={anyStore}
            onChange={setAnyStore}
            options={[
              { id: "one", label: "One store" },
              { id: "any", label: "Any store" },
            ]}
          />
          {anyStore === "one" ? (
            <input
              id={ids.store}
              aria-label="Store name"
              value={store}
              onChange={(e) => setStore(e.target.value)}
              placeholder="Store name"
              className="h-12 rounded-xl border bg-card px-4 outline-none focus-visible:border-foreground focus-visible:ring-4 focus-visible:ring-foreground/8"
            />
          ) : null}
        </div>

        <div className="grid gap-2.5">
          <Segmented label="Until" value={span} onChange={setSpan} options={WINDOWS} />
        </div>
      </fieldset>

      {error ? (
        <div className="mt-6">
          <ErrorNotice>{error}</ErrorNotice>
        </div>
      ) : null}

      {signing && compiled ? (
        <SignSheet
          open={confirming}
          onOpenChange={(open) => !busy && setConfirming(open)}
          signing={signing}
          compiled={compiled}
          busy={busy}
          onSign={() => sign(signing)}
        />
      ) : null}
    </OnboardingFrame>
  );
}
