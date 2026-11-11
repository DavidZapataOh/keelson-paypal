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
import { LINKED } from "../lib/embed";
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
  const link = params.get("link");
  return {
    initial,
    ref,
    back: back.toString(),
    ...(link && LINK.test(link) ? { link } : {}),
  };
}

const LINK = /^kel_[A-Za-z0-9_-]{43}$/;

/**
 * Opened by an embedded approval for a user it does not know yet. Once signed in here, the user
 * confirms the platform it names; the grant goes back only to the frame that opened this
 * window, on Keelson's own origin, which then creates their passkey if they have none and signs.
 */
function LinkEmbed({
  request,
  nonce,
  embedRef,
  back,
}: {
  request: ConnectionView;
  nonce: string;
  embedRef: string;
  back: string;
}) {
  const [link, setLink] = useState<{ origin: string } | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    post<{ origin: string; ref: string }>("/v1/embed/links/inspect", { nonce })
      .then((l) => setLink(l.ref === embedRef ? { origin: l.origin } : null))
      .catch(() => setLink(null));
  }, [nonce, embedRef]);
  // The frame that opened this window is on the API's origin; any other opener gets nothing.
  const opener = typeof window === "undefined" ? null : window.opener;
  const host = link ? new URL(link.origin).host : "";
  const confirm = async () => {
    if (!link || !opener) return;
    setBusy(true);
    setError(undefined);
    try {
      const { grant } = await post<{ grant: string }>("/v1/embed/links/confirm", {
        nonce,
        ref: embedRef,
      });
      (opener as Window).postMessage({ type: LINKED, grant }, new URL(API).origin);
      location.replace(back);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "The approval could not be linked.");
    }
  };
  if (link === undefined) {
    return (
      <p role="status" className="flex items-center gap-2 p-8 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Reading the request
      </p>
    );
  }
  if (link === null || !opener) {
    return (
      <Closed
        title="This link is no longer valid"
        line="Go back to the app that asked and open Keelson from its approval again."
      />
    );
  }
  return (
    <OnboardingFrame
      step="Agent"
      stage={<span className="size-3 rounded-full bg-graphite" aria-hidden="true" />}
      action={
        <Button
          size="lg"
          onClick={confirm}
          disabled={busy}
          className="h-13 w-full rounded-xl text-base"
        >
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Continue on {host}
        </Button>
      }
    >
      <h1 className="text-balance font-semibold text-[1.75rem] leading-[1.1] tracking-[-0.025em] sm:text-[2rem]">
        Approve on {host}
      </h1>
      <p className="mt-3 text-pretty text-lg text-muted-foreground leading-snug">
        {request.name}, run by {request.agent.operator}, asked for your approval in Keelson's panel
        on {host}. Continue only if you were there. Keelson's panel then asks for your passkey, or
        creates one if you have none, and nothing is approved until you sign. This window closes.
      </p>
      {error ? (
        <div className="mt-6">
          <ErrorNotice>{error}</ErrorNotice>
        </div>
      ) : null}
    </OnboardingFrame>
  );
}

/** `/connect?c=XXXX-XXXX`: an agent's request, approved here with a passkey or rejected. */
export function ConnectPage() {
  const params = useSearchParams();
  const code = params.get("c");
  const embed = embedReturn(params);
  const session = authClient.useSession();
  const [request, setRequest] = useState<ConnectionView | null>();
  const [error, setError] = useState<string>();

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
  if (embed?.link) {
    return (
      <LinkEmbed request={request} nonce={embed.link} embedRef={embed.ref} back={embed.back} />
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
