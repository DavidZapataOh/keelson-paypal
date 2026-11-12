"use client";

import { Button } from "@keelson/ui/components/button";
import { BookOpen, Check, ExternalLink, FileJson, Sparkles } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { get } from "../../lib/api";
import { authClient } from "../../lib/auth";
import type { AgentRow } from "../../lib/connections";
import { useEvents, userChannel } from "../../lib/events";
import { AppShell } from "../app-shell";
import { Snippet } from "./snippet";
import { DOCS, type Language, STEPS, type Step } from "./steps";

const COLLECTION =
  "https://raw.githubusercontent.com/DavidZapataOh/keelson-paypal/main/openapi/postman/keelson.postman_collection.json";
const CONTEXT =
  "claude mcp add --transport http keelson-docs https://api.keelson.finance/context/mcp";

interface ActivityRow {
  purchaseId: string | null;
  tone: "good" | "warn" | "bad";
}

type Progress = Record<Step["id"], boolean> & { purchaseId: string | null };

/** Where the signed-in user stands, read from their agents and activity. */
function progressOf(agents: AgentRow[], rows: ActivityRow[]): Progress {
  const apps = agents.filter((a) => a.clientId !== null);
  const bought = rows.find((r) => r.purchaseId && r.tone === "good");
  return {
    install: apps.length > 0,
    login: apps.length > 0,
    mandate: apps.some((a) => a.mandate?.state === "ACTIVE") || Boolean(bought),
    purchase: Boolean(bought),
    verify: Boolean(bought),
    purchaseId: bought?.purchaseId ?? null,
  };
}

function markdown(language: Language): string {
  return [
    "# Build with Keelson",
    ...STEPS.map(
      (s, i) =>
        `## ${i + 1}. ${s.title}\n\n${s.body}\n\n\`\`\`${language === "python" ? "python" : "ts"}\n${s.code[language]}\n\`\`\``,
    ),
    `## Docs for your coding assistant\n\n\`${CONTEXT}\``,
    `## Postman\n\n${COLLECTION}`,
  ].join("\n\n");
}

/** `/developers/`: from an empty folder to a verified purchase, each step ticking as it happens. */
export function DevelopersPage() {
  const session = authClient.useSession();
  const [language, setLanguage] = useState<Language>("typescript");
  const [progress, setProgress] = useState<Progress>();
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    if (!session.data) return;
    Promise.all([
      get<{ agents: AgentRow[] }>("/v1/agents"),
      get<{ rows: ActivityRow[] }>("/v1/activity"),
    ])
      .then(([a, r]) => setProgress(progressOf(a.agents, r.rows)))
      .catch(() => setProgress(undefined));
  }, [session.data]);
  useEffect(load, [load]);
  useEvents(session.data ? userChannel(session.data.user.id, "agents") : undefined, load, load);

  const current = progress ? STEPS.findIndex((s) => !progress[s.id]) : -1;

  return (
    <AppShell>
      <div className="grid gap-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid max-w-[46ch] gap-1">
            <h1 className="font-semibold text-[1.75rem] leading-tight tracking-[-0.025em]">
              Build with Keelson
            </h1>
            <p className="text-pretty text-muted-foreground">
              From an empty folder to a purchase you can verify, on the PayPal sandbox.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <div
              role="radiogroup"
              aria-label="Language"
              className="inline-flex rounded-xl border p-1"
            >
              {(["typescript", "python"] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  aria-pressed={language === l}
                  onClick={() => setLanguage(l)}
                  className={`h-8 rounded-lg px-3 font-medium text-sm ${language === l ? "bg-graphite text-bone" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {l === "typescript" ? "TypeScript" : "Python"}
                </button>
              ))}
            </div>
            <Button asChild variant="outline" size="lg" className="rounded-xl">
              <a href={DOCS} target="_blank" rel="noopener">
                <BookOpen aria-hidden="true" />
                Full docs
              </a>
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="rounded-xl"
              onClick={() =>
                navigator.clipboard.writeText(markdown(language)).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              <Sparkles aria-hidden="true" />
              {copied ? "Copied" : "Copy for AI"}
            </Button>
          </div>
        </div>

        <ol aria-label="Steps" className="grid gap-0">
          {STEPS.map((s, i) => {
            const done = progress?.[s.id] ?? false;
            const now = i === current;
            return (
              <li key={s.id} className="grid grid-cols-[2rem_1fr] gap-x-4">
                <div className="flex flex-col items-center">
                  <span
                    className={`grid size-8 shrink-0 place-items-center rounded-full font-semibold text-sm ${done ? "bg-graphite text-bone" : now ? "border-2 border-graphite" : "border text-muted-foreground"}`}
                  >
                    {done ? <Check className="size-4" aria-label="Done" /> : i + 1}
                  </span>
                  {i < STEPS.length - 1 ? <span className="w-px grow bg-border" /> : null}
                </div>
                <div className="grid min-w-0 gap-2.5 pb-8">
                  <div className="grid gap-0.5 pt-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <h2 className="font-semibold">{s.title}</h2>
                      <a
                        href={s.docs}
                        target="_blank"
                        rel="noopener"
                        aria-label={`${s.title} in the docs`}
                        className="inline-flex items-center gap-1 text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
                      >
                        Docs
                        <ExternalLink className="size-3.5" aria-hidden="true" />
                      </a>
                    </div>
                    <p className="text-pretty text-muted-foreground text-sm">{s.body}</p>
                  </div>
                  <Snippet code={s.code[language]} label={`${s.title} code`} />
                  {s.id === "verify" && progress?.purchaseId ? (
                    <a
                      href={`https://verify.keelson.finance/?id=${progress.purchaseId}`}
                      target="_blank"
                      rel="noopener"
                      className="inline-flex h-9 w-fit items-center gap-1.5 rounded-lg border px-3 font-medium text-sm hover:bg-foreground/5"
                    >
                      Verify {progress.purchaseId.slice(0, 8)}… in your browser
                      <ExternalLink className="size-3.5" aria-hidden="true" />
                    </a>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>

        {session.data === null ? (
          <p className="text-muted-foreground text-sm">
            <Link
              href="/sign-in/"
              className="font-medium text-foreground underline underline-offset-4"
            >
              Sign in
            </Link>{" "}
            to see each step tick as your code runs.
          </p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <section
            aria-labelledby="context"
            className="grid content-start gap-3 rounded-3xl border bg-card p-5"
          >
            <div className="grid gap-0.5">
              <h2 id="context" className="font-semibold">
                Docs for your coding assistant
              </h2>
              <p className="text-muted-foreground text-sm">
                The Keelson Context Plugin: these docs, every operation and its types, over MCP.
              </p>
            </div>
            <Snippet code={CONTEXT} label="Context Plugin install" />
          </section>
          <section
            aria-labelledby="postman"
            className="grid content-start gap-3 rounded-3xl border bg-card p-5"
          >
            <div className="grid gap-0.5">
              <h2 id="postman" className="font-semibold">
                Try it in Postman
              </h2>
              <p className="text-muted-foreground text-sm">
                Every operation, signed in with OAuth and PKCE. Import it from the link.
              </p>
            </div>
            <Button asChild variant="outline" size="lg" className="w-fit rounded-xl">
              <a href={COLLECTION} target="_blank" rel="noopener">
                <FileJson aria-hidden="true" />
                Postman collection
              </a>
            </Button>
          </section>
        </div>
      </div>
    </AppShell>
  );
}
