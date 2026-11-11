"use client";

import { Button } from "@keelson/ui/components/button";
import { Check, Copy, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useId, useState } from "react";
import { ApiError, get, post } from "../lib/api";
import { authClient } from "../lib/auth";
import { API } from "../lib/config";
import { CONNECT_PROMPT, type ConnectionView } from "../lib/connections";
import { Approval, type Chosen } from "./approval";
import { ErrorNotice } from "./notice";
import { OnboardingFrame } from "./onboarding/frame";
import { Welcome } from "./welcome";

const CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-?[BCDFGHJKLMNPQRSTVWXZ]{4}$/i;

/** The prompt to paste into the agent, with a copy button that says it copied. */
function PromptBlock() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative grid gap-2">
      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must take keyboard focus (WCAG 2.1.1)
        tabIndex={0}
        aria-label="Prompt for your agent"
        className="max-h-56 overflow-y-auto rounded-xl bg-graphite px-4 py-3.5 pr-12"
      >
        <pre className="whitespace-pre-wrap font-mono text-[13px] text-bone leading-relaxed">
          {CONNECT_PROMPT}
        </pre>
      </section>
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(CONNECT_PROMPT);
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        }}
        className="absolute top-2.5 right-2.5 grid size-9 place-items-center rounded-lg bg-bone/10 text-bone transition-colors hover:bg-bone/20"
        aria-label={copied ? "Copied" : "Copy the prompt"}
      >
        {copied ? (
          <Check className="size-4" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
      </button>
      <span role="status" className="sr-only">
        {copied ? "Prompt copied" : ""}
      </span>
    </div>
  );
}

/** First run: the prompt for the agent, then the code it shows, which opens its request. */
function ConnectAgent() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const id = useId();
  const valid = CODE.test(code.trim());
  const open = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const bare = code.trim().toUpperCase().replace("-", "");
    router.push(`/connect/?c=${bare.slice(0, 4)}-${bare.slice(4)}`);
  };
  return (
    <OnboardingFrame
      step="Agent"
      stageLabel="Waiting for your agent"
      stage={
        <div className="grid w-full max-w-[400px] justify-items-center gap-5 text-center">
          <span className="relative grid size-20 place-items-center rounded-full bg-card shadow-[0_12px_30px_-16px_rgb(23_24_27/0.45)]">
            <span className="absolute inset-0 animate-ping rounded-full bg-graphite/10 motion-reduce:animate-none" />
            <span className="size-3 rounded-full bg-graphite" />
          </span>
          <p className="text-pretty text-muted-foreground">
            Waiting for your agent's request. It shows a link and a code like{" "}
            <span className="font-mono text-foreground">BCDF-GHJK</span>.
          </p>
        </div>
      }
      action={
        <form onSubmit={open} className="grid grid-cols-[1fr_auto] gap-2">
          <label htmlFor={id} className="sr-only">
            The code your agent shows
          </label>
          <input
            id={id}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Code, e.g. BCDF-GHJK"
            autoComplete="one-time-code"
            spellCheck={false}
            className="h-13 rounded-xl border bg-card px-4 font-mono uppercase tracking-wider outline-none placeholder:normal-case placeholder:tracking-normal placeholder:text-muted-foreground focus-visible:border-foreground focus-visible:ring-4 focus-visible:ring-foreground/8"
          />
          <Button type="submit" size="lg" disabled={!valid} className="h-13 rounded-xl text-base">
            Open
          </Button>
        </form>
      }
    >
      <h1 className="text-balance font-semibold text-[1.75rem] leading-[1.1] tracking-[-0.025em] sm:text-[2rem]">
        Connect your agent
      </h1>
      <p className="mt-3 text-pretty text-lg text-muted-foreground leading-snug">
        Paste this into your agent. It asks; you approve here.
      </p>
      <div className="mt-6">
        <PromptBlock />
      </div>
    </OnboardingFrame>
  );
}

function Closed({ title, line }: { title: string; line: string }) {
  return (
    <OnboardingFrame
      step="Agent"
      stage={<span className="size-3 rounded-full bg-foreground/20" aria-hidden="true" />}
      action={
        <div className="grid grid-cols-2 gap-2">
          <Button asChild size="lg" variant="outline" className="h-13 rounded-xl">
            <Link href="/connect/">Enter a code</Link>
          </Button>
          <Button asChild size="lg" className="h-13 rounded-xl text-base">
            <Link href="/agents/">Your agents</Link>
          </Button>
        </div>
      }
    >
      <h1 className="text-balance font-semibold text-[1.75rem] leading-[1.1] tracking-[-0.025em] sm:text-[2rem]">
        {title}
      </h1>
      <p className="mt-3 text-pretty text-lg text-muted-foreground leading-snug">{line}</p>
    </OnboardingFrame>
  );
}

/**
 * Before a request opens: the user picks the two-digit number their agent shows beside the link,
 * out of three. A link someone else relayed has no agent of theirs showing it, so a wrong pick
 * denies the request.
 */
function NumberMatch({
  request,
  onMatched,
  onMismatch,
}: {
  request: ConnectionView;
  onMatched: () => void;
  onMismatch: (line: string) => void;
}) {
  const [busy, setBusy] = useState<number>();
  const [error, setError] = useState<string>();
  const pick = async (number: number) => {
    setBusy(number);
    setError(undefined);
    try {
      await post(`/v1/connections/${request.code}/match`, { number });
      onMatched();
    } catch (e) {
      if (e instanceof ApiError && e.slug === "number-mismatch") onMismatch(e.message);
      else setError(e instanceof Error ? e.message : "It could not be checked. Try again.");
      setBusy(undefined);
    }
  };
  return (
    <OnboardingFrame
      step="Agent"
      stageLabel="Your agent's number"
      stage={
        <div className="grid w-full max-w-[400px] justify-items-center gap-4 text-center">
          <span className="grid size-24 place-items-center rounded-3xl bg-card font-mono font-semibold text-4xl tabular-nums shadow-[0_12px_30px_-16px_rgb(23_24_27/0.45)]">
            ??
          </span>
          <p className="text-pretty text-muted-foreground">
            {request.name} shows a two-digit number next to the link it gave you.
          </p>
        </div>
      }
      action={
        <fieldset className="grid gap-2">
          <legend className="sr-only">Pick the number {request.name} shows</legend>
          <div className="grid grid-cols-3 gap-2">
            {(request.match?.options ?? []).map((n) => (
              <Button
                key={n}
                type="button"
                size="lg"
                variant="outline"
                disabled={busy !== undefined}
                onClick={() => pick(n)}
                className="h-16 rounded-2xl font-mono font-semibold text-2xl tabular-nums"
              >
                {busy === n ? <Loader2 className="size-5 animate-spin" aria-hidden="true" /> : n}
              </Button>
            ))}
          </div>
          <p className="text-center text-muted-foreground text-sm">
            Not sure? Look at your agent's last message. Don't guess.
          </p>
        </fieldset>
      }
    >
      <h1 className="text-balance font-semibold text-[1.75rem] leading-[1.1] tracking-[-0.025em] sm:text-[2rem]">
        Which number does {request.name} show?
      </h1>
      <p className="mt-3 text-pretty text-lg text-muted-foreground leading-snug">
        This proves the link came from your own agent. A wrong pick cancels the request.
      </p>
      {error ? (
        <div className="mt-6">
          <ErrorNotice>{error}</ErrorNotice>
        </div>
      ) : null}
    </OnboardingFrame>
  );
}

const EMBED_REF = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Opened by an agent platform's embedded approval (`embed`, `via`): the limits the user lowered
 * there, and where to return once answered. The return is always the API's own embed page, so no
 * parameter here can send the user elsewhere.
 */
function embedReturn(params: URLSearchParams) {
  const ref = params.get("embed") ?? "";
  const via = params.get("via");
  if (!EMBED_REF.test(ref) || (via !== "frame" && via !== "popup")) return undefined;
  const int = (k: string) => {
    const v = Number(params.get(k));
    return Number.isSafeInteger(v) && v > 0 ? v : undefined;
  };
  const merchants = params.get("m")?.split(",").filter(Boolean);
  const until = params.get("u") ?? undefined;
  const initial: Partial<Chosen> = {};
  const pp = int("pp");
  const tt = int("tt");
  const aa = int("aa");
  if (pp) initial.perPurchase = pp;
  if (tt) initial.total = tt;
  if (aa) initial.askAbove = aa;
  if (merchants?.length) initial.merchants = merchants;
  if (until) initial.until = until;
  const back = new URL("/embed/approve", API);
  back.search = new URLSearchParams({ r: ref, mode: via, step: "done" }).toString();
  return { initial, back: back.toString() };
}

/** `/connect?c=XXXX-XXXX`: an agent's request, approved here with a passkey or rejected. */
export function ConnectPage() {
  const params = useSearchParams();
  const code = params.get("c");
  const embed = embedReturn(params);
  const session = authClient.useSession();
  const [request, setRequest] = useState<ConnectionView | null>();
  const [error, setError] = useState<string>();
  const [mismatch, setMismatch] = useState<string>();

  useEffect(() => {
    if (!code || !session.data) return;
    get<ConnectionView>(`/v1/connections/${encodeURIComponent(code)}`)
      .then(setRequest)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) setRequest(null);
        else setError(e instanceof Error ? e.message : "The request could not be read.");
      });
  }, [code, session.data]);

  if (session.isPending) {
    return (
      <p role="status" className="sr-only">
        Loading
      </p>
    );
  }
  if (!session.data) {
    return (
      <Welcome
        title={code ? "Sign in to answer your agent" : "Sign in to connect your agent"}
        line="Your agent asked to spend with your PayPal. Only you can approve it."
        returnTo={typeof location === "undefined" ? undefined : location.href}
      />
    );
  }
  if (!code) return <ConnectAgent />;
  if (error) {
    return (
      <div className="mx-auto max-w-xl px-5 py-12">
        <ErrorNotice>{error}</ErrorNotice>
      </div>
    );
  }
  if (request === undefined) {
    return (
      <p role="status" className="flex items-center gap-2 p-8 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Reading the request
      </p>
    );
  }
  if (request === null) {
    return (
      <Closed
        title="No request with this code"
        line="Check the code your agent shows, or ask it for a new one."
      />
    );
  }
  if (mismatch) {
    return <Closed title="That's not your agent's number" line={mismatch} />;
  }
  if (request.state === "EXPIRED") {
    return (
      <Closed
        title="This request expired"
        line={`Codes last 15 minutes. Ask ${request.name} for a new one.`}
      />
    );
  }
  if (request.state === "DENIED") {
    return <Closed title="Already declined" line={`${request.name} was told no.`} />;
  }
  if (request.state === "APPROVED") {
    return (
      <Closed
        title="Already approved"
        line="This code was used. Your agents page shows the grant."
      />
    );
  }
  const match = request.match;
  if (match && !match.matched && !embed) {
    return (
      <NumberMatch
        request={request}
        onMatched={() => setRequest({ ...request, match: { ...match, matched: true } })}
        onMismatch={setMismatch}
      />
    );
  }
  if (embed) {
    const done = () => location.replace(embed.back);
    return (
      <Approval
        request={request}
        initial={embed.initial}
        onApproved={done}
        onDeclined={done}
        continueLabel={`Returning to ${request.agent.operator}`}
      />
    );
  }
  return <Approval request={request} />;
}
