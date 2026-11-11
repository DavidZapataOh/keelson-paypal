"use client";

import { Button } from "@keelson/ui/components/button";
import { Ban, Check, Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { get, post } from "../lib/api";
import { authClient } from "../lib/auth";
import type { ConnectionView } from "../lib/connections";
import { money } from "../lib/format";
import { Approval, Chip } from "./approval";
import { ErrorNotice } from "./notice";
import { OnboardingFrame } from "./onboarding/frame";

interface Consent {
  client: { id: string; name: string; uri: string | null; verified: boolean };
  agent: { agentId: string; operator: string } | null;
  scopes: string[];
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

/** Each scope in the words of what it lets the app do. */
const SCOPE_WORDS: Record<string, string> = {
  "alibis:read": "See the receipts (Alibis) of purchases made for you",
  "disputes:read": "See your disputes and how they were decided",
  "countersign:write": "Ask Keelson to check carts against your mandate",
  "evidence:write": "Send the store pages it read as evidence",
};

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

  return (
    <OnboardingFrame
      step="Agent"
      stageLabel={consent ? `${consent.client.name} asks to connect` : undefined}
      stage={
        consent ? (
          <div className="grid w-full max-w-[380px] justify-items-center gap-4 text-center">
            <span className="grid size-20 place-items-center rounded-3xl bg-card font-semibold text-3xl shadow-[0_12px_30px_-16px_rgb(23_24_27/0.45)]">
              {consent.client.name.slice(0, 1).toUpperCase()}
            </span>
            <p className="grid gap-0.5">
              <span className="font-semibold text-lg">{consent.client.name}</span>
              <span className="truncate text-muted-foreground text-sm">
                {consent.client.uri ?? consent.client.id}
              </span>
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
            <div className="flex flex-wrap gap-1.5">
              {consent.client.verified ? (
                <Chip>
                  <Check className="size-3.5" aria-hidden="true" />
                  Registered agent #{consent.agent?.agentId}
                </Chip>
              ) : (
                <Chip>
                  <TriangleAlert className="size-3.5 text-warn" aria-hidden="true" />
                  Unverified client
                </Chip>
              )}
            </div>
            <h1 className="text-balance font-semibold text-[1.75rem] leading-[1.1] tracking-[-0.025em] sm:text-[2rem]">
              {consent.client.name} wants to connect
            </h1>
            <p className="text-pretty text-muted-foreground leading-snug">
              {consent.client.verified
                ? `Run by ${consent.agent?.operator}. It acts for you only within what you allow.`
                : "Keelson has not linked this app to a registered agent. Only continue if you started this."}
            </p>
          </div>

          <section aria-labelledby="requested" className="mt-6">
            <h2 id="requested" className="font-semibold">
              Requested permissions
            </h2>
            <ul className="mt-1 divide-y">
              {consent.scopes.map((scope) => (
                <li key={scope}>
                  <label className="flex cursor-pointer items-center gap-3 py-3">
                    <input
                      type="checkbox"
                      checked={scopes.includes(scope)}
                      onChange={(e) =>
                        setScopes((now) =>
                          e.target.checked ? [...now, scope] : now.filter((x) => x !== scope),
                        )
                      }
                      className="size-4 accent-[var(--color-graphite)]"
                    />
                    <span className="flex-1">{SCOPE_WORDS[scope] ?? scope}</span>
                  </label>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="spending" className="mt-4 grid gap-2">
            <h2 id="spending" className="font-semibold">
              Spending
            </h2>
            {s && cap ? (
              <>
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
              </>
            ) : (
              <p className="flex gap-2 text-pretty text-sm">
                <Ban className="mt-0.5 size-4 shrink-0 text-vermilion-deep" aria-hidden="true" />
                {consent.spendingError
                  ? `It asked to spend, but cannot be allowed to: ${consent.spendingError}`
                  : "It cannot spend. To buy, it must ask you for a mandate, which you approve with your passkey."}
              </p>
            )}
          </section>
        </>
      ) : error ? null : (
        <p role="status" className="sr-only">
          Loading
        </p>
      )}
    </OnboardingFrame>
  );
}
