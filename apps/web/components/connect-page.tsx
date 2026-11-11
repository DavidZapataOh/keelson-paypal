"use client";

import { Button } from "@keelson/ui/components/button";
import { CopyValue } from "@keelson/ui/components/copy-value";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@keelson/ui/components/tabs";
import { Check, Copy, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import { ApiError, get, post } from "../lib/api";
import { authClient } from "../lib/auth";
import { API } from "../lib/config";
import { CONNECT_PROMPT, type ConnectionView } from "../lib/connections";
import { Approval, type Chosen } from "./approval";
import { ErrorNotice } from "./notice";
import { OnboardingFrame } from "./onboarding/frame";
import { Welcome } from "./welcome";

const CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-?[BCDFGHJKLMNPQRSTVWXZ]{4}$/i;

/** Text to paste somewhere else, in mono on graphite, with a copy button that says it copied. */
function CodeBlock({ text, label, noun }: { text: string; label: string; noun: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative grid gap-2">
      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must take keyboard focus (WCAG 2.1.1)
        tabIndex={0}
        aria-label={label}
        className="max-h-56 overflow-auto rounded-xl bg-graphite px-4 py-3.5 pr-12 outline-none focus-visible:ring-4 focus-visible:ring-foreground/15"
      >
        <pre className="whitespace-pre-wrap break-words font-mono text-[13px] text-bone leading-relaxed">
          {text}
        </pre>
      </section>
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        }}
        className="absolute top-2.5 right-2.5 grid size-9 place-items-center rounded-lg bg-bone/10 text-bone transition-colors hover:bg-bone/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bone/60"
        aria-label={copied ? "Copied" : `Copy the ${noun}`}
      >
        {copied ? (
          <Check className="size-4" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
      </button>
      <span role="status" className="sr-only">
        {copied ? `${noun[0]?.toUpperCase()}${noun.slice(1)} copied` : ""}
      </span>
    </div>
  );
}

const MCP_URL = "https://api.keelson.finance/mcp";
const CLAUDE_CODE = `claude mcp add --transport http keelson ${MCP_URL}`;
const CURSOR_JSON = JSON.stringify({ mcpServers: { keelson: { url: MCP_URL } } }, null, 2);

/** A menu path or a value the user picks, set apart from the sentence around it. */
function Ui({ children }: { children: ReactNode }) {
  return <span className="whitespace-nowrap font-medium text-foreground">{children}</span>;
}

/** The server URL as the host's form asks for it, with its copy button. */
function ServerUrl() {
  return (
    <CopyValue
      value={MCP_URL}
      label="the server URL"
      className="mt-2 w-full justify-between rounded-lg border bg-card py-1 pr-1 pl-3 text-[13px] text-foreground"
    />
  );
}

interface Host {
  id: string;
  name: string;
  steps: ReactNode[];
  note: ReactNode;
}

const HOSTS: Host[] = [
  {
    id: "claude",
    name: "Claude",
    steps: [
      <>
        In claude.ai or Claude Desktop, open <Ui>Customize → Connectors</Ui>, select <Ui>Add</Ui>,
        then <Ui>Add custom connector</Ui>.
      </>,
      <>
        Name it Keelson, paste the server URL and select <Ui>Continue</Ui>.
        <ServerUrl />
      </>,
      <>
        Keep the sign-in settings marked <Ui>Detected</Ui>. If it asks for an OAuth client, pick{" "}
        <Ui>Register automatically</Ui>. Select <Ui>Add</Ui>, then <Ui>Connect</Ui>, and sign in to
        Keelson.
      </>,
    ],
    note: (
      <>
        Connectors start off in a new chat: turn Keelson on in each chat from{" "}
        <Ui>+ → Connectors</Ui>.
      </>
    ),
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    steps: [
      <>
        On chatgpt.com, open <Ui>Plugins</Ui>, select <Ui>+</Ui>, then{" "}
        <Ui>Add custom MCP server</Ui>.
      </>,
      <>
        Name it Keelson and paste the server URL under <Ui>Connection</Ui>.
        <ServerUrl />
      </>,
      <>
        Set authentication to <Ui>OAuth</Ui>, not “No authentication”. Accept the risk notice,
        select <Ui>Create as a plugin</Ui> and sign in to Keelson.
      </>,
    ],
    note: (
      <>
        Web only, in a Business, Enterprise or Edu workspace that allows custom MCP servers. In a
        chat, type <Ui>@</Ui> and pick Keelson for each message that needs it.
      </>
    ),
  },
  {
    id: "cursor",
    name: "Cursor",
    steps: [
      <>
        Add Keelson to <Ui>~/.cursor/mcp.json</Ui>, or to <Ui>.cursor/mcp.json</Ui> in one project.
        <div className="mt-2">
          <CodeBlock text={CURSOR_JSON} label="Cursor configuration" noun="configuration" />
        </div>
      </>,
      <>
        Cursor registers itself with Keelson and opens the sign-in in your browser. Sign in to
        Keelson.
      </>,
    ],
    note: <>Keelson then appears in Cursor's MCP settings with its tools.</>,
  },
  {
    id: "claude-code",
    name: "Claude Code",
    steps: [
      <>
        In a terminal, add the server.
        <div className="mt-2">
          <CodeBlock text={CLAUDE_CODE} label="Claude Code command" noun="command" />
        </div>
      </>,
      <>
        In Claude Code, run <Ui>/mcp</Ui>, pick keelson and sign in to Keelson.
      </>,
    ],
    note: <>Claude Code opens approval pages in your browser for you; you still pick the number.</>,
  },
];

/** Where the agent runs, as tabs: the exact steps to add Keelson's MCP server there. */
function HostSteps() {
  return (
    <Tabs defaultValue="claude" className="gap-0">
      <TabsList
        aria-label="Your agent's app"
        className="grid h-auto w-full grid-cols-4 rounded-xl bg-bone-2 p-1"
      >
        {HOSTS.map((h) => (
          <TabsTrigger
            key={h.id}
            value={h.id}
            className="h-10 rounded-lg px-1.5 text-[13px] text-muted-foreground data-[state=active]:border-transparent data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-[0_1px_2px_rgb(23_24_27/0.08),0_4px_12px_-6px_rgb(23_24_27/0.25)] focus-visible:ring-2 focus-visible:ring-foreground/40 sm:text-sm"
          >
            {h.name}
          </TabsTrigger>
        ))}
      </TabsList>
      {HOSTS.map((h) => (
        <TabsContent key={h.id} value={h.id} className="pt-5">
          <ol className="grid gap-4">
            {h.steps.map((step, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: the steps are fixed and ordered
                key={i}
                className="grid grid-cols-[1.5rem_1fr] gap-x-3 text-pretty text-[15px] text-muted-foreground leading-snug"
              >
                <span
                  aria-hidden="true"
                  className="grid size-6 place-items-center rounded-full bg-foreground/[0.07] font-mono text-[11px] text-foreground tabular-nums"
                >
                  {i + 1}
                </span>
                <div className="min-w-0 pt-0.5">{step}</div>
              </li>
            ))}
          </ol>
          <p className="mt-4 rounded-lg bg-bone-2/70 px-3 py-2.5 text-pretty text-[13px] text-muted-foreground leading-snug">
            {h.note}
          </p>
        </TabsContent>
      ))}
    </Tabs>
  );
}

/** First run: where to add Keelson, the prompt for the agent, then the code it shows. */
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
        Add Keelson where your agent runs, then paste the prompt. It asks; you approve here.
      </p>
      <div className="mt-6">
        <HostSteps />
      </div>
      <h2 className="mt-8 font-semibold text-base">Then paste this into your agent</h2>
      <p className="mt-1 text-pretty text-muted-foreground text-sm leading-snug">
        Signed in, your agent's app can ask you for a mandate and buy within the ones you approve
        for it, nothing more. Every mandate waits for your passkey here.
      </p>
      <div className="mt-3">
        <CodeBlock text={CONNECT_PROMPT} label="Prompt for your agent" noun="prompt" />
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
        Picking it confirms you're answering your own agent, not a link someone forwarded you. A
        wrong pick cancels the request.
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
  if (match && !match.matched) {
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
