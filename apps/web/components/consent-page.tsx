"use client";

import { Button } from "@keelson/ui/components/button";
import { Ban, Fingerprint, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { get, post } from "../lib/api";
import { authClient } from "../lib/auth";
import type { ClientIdentity, ConnectionView } from "../lib/connections";
import { money } from "../lib/format";
import { Approval } from "./approval";
import { SplitK } from "./brand";
import { IdentityRow } from "./identity-row";
import { ErrorNotice } from "./notice";
import { OnboardingFrame } from "./onboarding/frame";

interface Consent {
  client: {
    id: string;
    name: string;
    uri: string | null;
    verified: boolean;
    identity?: ClientIdentity;
  };
  agent: { agentId: string; operator: string; hosted: boolean } | null;
  scopes: string[];
  /** For an app Keelson does not know acting through its own agent: what its bond backs per user. */
  hostedCap: { perUserMinor: string; currency: string; knownHost: boolean } | null;
  spending: {
    name: string;
    reason: string;
    limits: {
      currency: string;
      perPurchaseMinor: number;
      totalMinor: number;
      merchants: string[];
      until: string;
      askAboveMinor?: number;
    };
  } | null;
  spendingError: string | null;
}

/** Each permission in the words of what it lets the app do, in the order a purchase runs. */
const SCOPE_WORDS: Record<string, { title: string; detail: string }> = {
  "mandates:request": {
    title: "Ask you for a spending mandate",
    detail: "You set the limits and approve it with your passkey. Nothing is spent until you do.",
  },
  "evidence:write": {
    title: "Keep what it read at the store",
    detail: "The product and cart pages are sealed as evidence for each purchase.",
  },
  "purchases:write": {
    title: "Buy within a mandate you signed",
    detail: "Two independent checks compare every cart to your mandate before PayPal is charged.",
  },
  "alibis:read": {
    title: "Show you the receipt of each purchase",
    detail: "The Alibi that proves what was bought, and who answers for it.",
  },
  offline_access: {
    title: "Stay connected until you stop it",
    detail: "So it does not ask you to sign in again every hour.",
  },
  "countersign:write": {
    title: "Ask Keelson to check carts against your mandate",
    detail: "Every cart is compared to what you signed before PayPal is charged.",
  },
  "disputes:read": {
    title: "See your disputes and how they were decided",
    detail: "Only disputes of purchases it made for you.",
  },
};
const ORDER = Object.keys(SCOPE_WORDS);
const ordered = (scopes: string[]) =>
  [...scopes].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));

/** What no permission grants, whatever the app asks: shown, never offered as a choice. */
const NEVER = [
  "See your PayPal login, your card or your password.",
  "Spend above what you sign. Keelson refuses before PayPal is charged.",
  "Act for anyone else, or under a mandate you approved for another app.",
];

const day = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));

/** The query the authorization server signed, without anything the page itself added. */
const signedQuery = () => (typeof location === "undefined" ? "" : location.search.slice(1));

async function answer(accept: boolean, scope?: string[]) {
  const { data, error } = await authClient.$fetch<{ url: string }>("/oauth2/consent", {
    method: "POST",
    body: { accept, ...(scope ? { scope: scope.join(" ") } : {}), oauth_query: signedQuery() },
  });
  if (error || !data) throw new Error(error?.message ?? "The answer could not be sent.");
  location.assign(data.url);
}

/**
 * The OAuth consent of an app that connects to Keelson as you (an MCP client): who it is and
 * whether Keelson knows it, what it may read, and the spending it asks for, which it may only get
 * through a mandate you approve with your passkey on the next step.
 */
export function ConsentPage() {
  const [consent, setConsent] = useState<Consent>();
  const [scopes, setScopes] = useState<string[]>([]);
  const [request, setRequest] = useState<ConnectionView>();
  const [busy, setBusy] = useState<"allow" | "deny">();
  const [error, setError] = useState<string>();

  useEffect(() => {
    post<Consent>("/v1/oauth/consent", { oauthQuery: signedQuery() })
      .then((c) => {
        setConsent(c);
        setScopes(c.scopes);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "The request could not be read."));
  }, []);

  if (request && consent) {
    return (
      <Approval
        request={request}
        continueLabel={`Returning to ${consent.client.name}`}
        onApproved={() => void answer(true, scopes).catch((e) => setError(String(e)))}
        onDeclined={() => void answer(false)}
      />
    );
  }

  const allow = async () => {
    if (!consent) return;
    setBusy("allow");
    setError(undefined);
    try {
      if (consent.spending) {
        const { userCode } = await post<{ userCode: string }>("/v1/oauth/consent/connection", {
          oauthQuery: signedQuery(),
        });
        setRequest(await get<ConnectionView>(`/v1/connections/${userCode}`));
        setBusy(undefined);
        return;
      }
      await answer(true, scopes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(undefined);
    }
  };
  const deny = async () => {
    setBusy("deny");
    try {
      await answer(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(undefined);
    }
  };

  const s = consent?.spending;
  const cap = s ? money(BigInt(s.limits.totalMinor), s.limits.currency) : null;
  const initial = consent?.client.name.slice(0, 1).toUpperCase() ?? "";

  return (
    <OnboardingFrame
      step="Agent"
      stageLabel={consent ? `${consent.client.name} connects to Keelson for you` : undefined}
      stage={
        consent ? (
          <div className="grid w-full max-w-[400px] justify-items-center gap-6 text-center">
            <div className="flex items-center gap-3">
              <span className="grid size-20 place-items-center rounded-3xl bg-card font-semibold text-3xl shadow-[0_12px_30px_-16px_rgb(23_24_27/0.45)]">
                {initial}
              </span>
              <span className="flex items-center gap-1" aria-hidden="true">
                <span className="size-1.5 rounded-full bg-foreground/25" />
                <span className="size-1.5 rounded-full bg-foreground/45" />
                <span className="size-1.5 rounded-full bg-vermilion" />
              </span>
              <span className="grid size-20 place-items-center rounded-3xl bg-graphite shadow-[0_12px_30px_-16px_rgb(23_24_27/0.6)]">
                <SplitK className="size-10" stem="var(--color-bone)" />
              </span>
            </div>
            <p className="grid gap-0.5">
              <span className="font-semibold text-lg">{consent.client.name}</span>
              <span className="truncate text-muted-foreground text-sm">
                {consent.client.identity?.kind === "cimd"
                  ? consent.client.identity.host
                  : (consent.client.uri ?? consent.client.id)}
              </span>
            </p>
            <p className="flex max-w-[34ch] items-start gap-2 text-left text-pretty text-sm">
              <Fingerprint className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              Every mandate it asks for waits for your passkey, on this page, never in the app.
            </p>
          </div>
        ) : (
          <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
        )
      }
      action={
        <div className="grid grid-cols-2 gap-2">
          <Button
            size="lg"
            variant="outline"
            onClick={deny}
            disabled={!consent || busy !== undefined}
            className="h-13 rounded-xl text-base"
          >
            {busy === "deny" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            Deny
          </Button>
          <Button
            size="lg"
            onClick={allow}
            disabled={!consent || busy !== undefined || scopes.length === 0}
            className="h-13 rounded-xl text-base"
          >
            {busy === "allow" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {s ? "Allow, then approve" : "Allow"}
          </Button>
        </div>
      }
    >
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
      {consent ? (
        <>
          <div className="grid gap-3">
            <IdentityRow identity={consent.client.identity} name={consent.client.name} />
            <h1 className="text-balance font-semibold text-[1.75rem] leading-[1.1] tracking-[-0.025em] sm:text-[2rem]">
              {consent.client.name} wants to connect
            </h1>
            <p className="text-pretty text-muted-foreground leading-snug">
              {consent.client.identity?.kind === "cimd"
                ? `Keelson confirmed it is ${consent.client.identity.host}'s app. It acts for you only within what you allow.`
                : consent.client.identity?.kind === "operator"
                  ? `Run by ${consent.client.identity.operator}. It acts for you only within what you allow.`
                  : "This app named itself. Only continue if you started this."}
            </p>
          </div>

          <section aria-labelledby="can" className="mt-7">
            <h2 id="can" className="font-semibold">
              It can
            </h2>
            <ul className="mt-1 divide-y">
              {ordered(consent.scopes).map((scope) => {
                const words = SCOPE_WORDS[scope];
                return (
                  <li key={scope}>
                    <label className="flex cursor-pointer items-start gap-3 py-3">
                      <input
                        type="checkbox"
                        checked={scopes.includes(scope)}
                        onChange={(e) =>
                          setScopes((now) =>
                            e.target.checked ? [...now, scope] : now.filter((x) => x !== scope),
                          )
                        }
                        className="mt-1 size-4 shrink-0 accent-[var(--color-graphite)]"
                      />
                      <span className="grid flex-1 gap-0.5">
                        <span className="font-medium leading-snug">{words?.title ?? scope}</span>
                        {words ? (
                          <span className="text-pretty text-muted-foreground text-sm leading-snug">
                            {words.detail}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>

          <section aria-labelledby="never" className="mt-5">
            <h2 id="never" className="font-semibold">
              It can never
            </h2>
            <ul className="mt-1 divide-y">
              {NEVER.map((line) => (
                <li key={line} className="flex items-start gap-3 py-3">
                  <Ban className="mt-1 size-4 shrink-0 text-vermilion-deep" aria-hidden="true" />
                  <span className="flex-1 text-pretty leading-snug">{line}</span>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="answers" className="mt-5 grid gap-2">
            <h2 id="answers" className="font-semibold">
              Who answers for its purchases
            </h2>
            {consent.agent ? (
              <p className="flex items-start gap-3 text-pretty leading-snug">
                <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  {consent.agent.hosted
                    ? `Keelson's own agent, #${consent.agent.agentId}, signs each purchase ${consent.client.name} makes, and its bond covers them.`
                    : `${consent.agent.operator}, registered agent #${consent.agent.agentId}, signs each purchase, and its bond covers them.`}
                </span>
              </p>
            ) : null}
            {consent.agent && consent.hostedCap ? (
              <p className="flex items-start gap-3 text-pretty text-sm leading-snug">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  {consent.hostedCap.knownHost
                    ? `${consent.client.name} acts through Keelson's hosted operator, so its bond backs at most `
                    : `Keelson does not know ${consent.client.name}, so its bond backs at most `}
                  <span className="font-medium tnum">
                    {money(BigInt(consent.hostedCap.perUserMinor), consent.hostedCap.currency)}
                  </span>{" "}
                  {consent.hostedCap.knownHost
                    ? "across your open mandates and recent purchases with apps acting through it."
                    : "across your open mandates and recent purchases with apps it does not know."}
                </span>
              </p>
            ) : consent.agent ? null : (
              <p className="flex items-start gap-3 text-pretty text-sm">
                <Ban className="mt-0.5 size-4 shrink-0 text-vermilion-deep" aria-hidden="true" />
                No registered agent answers for this app, so it cannot buy for you.
              </p>
            )}
          </section>

          {s && cap ? (
            <section aria-labelledby="spending" className="mt-5 grid gap-2">
              <h2 id="spending" className="font-semibold">
                Spending
              </h2>
              <p className="text-pretty">
                It asks to spend up to {cap} in total,{" "}
                {money(BigInt(s.limits.perPurchaseMinor), s.limits.currency)} per purchase, until{" "}
                {day(s.limits.until)}
                {s.limits.askAboveMinor
                  ? `, asking you above ${money(BigInt(s.limits.askAboveMinor), s.limits.currency)}`
                  : ""}
                . You approve it with your passkey next, and may lower any of it.
              </p>
              <p className="flex gap-2 text-sm">
                <Ban className="mt-0.5 size-4 shrink-0 text-vermilion-deep" aria-hidden="true" />
                It cannot pay outside these rules: Keelson refuses before PayPal is charged.
              </p>
            </section>
          ) : consent.spendingError ? (
            <p className="mt-5 flex gap-2 text-pretty text-sm">
              <Ban className="mt-0.5 size-4 shrink-0 text-vermilion-deep" aria-hidden="true" />
              It asked to spend, but cannot be allowed to: {consent.spendingError}
            </p>
          ) : null}
        </>
      ) : error ? null : (
        <p role="status" className="sr-only">
          Loading
        </p>
      )}
    </OnboardingFrame>
  );
}
