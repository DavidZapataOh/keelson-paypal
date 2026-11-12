import type { AnyAlibi } from "@keelson/alibi";
import type { AnonymousPurchase, AnonymousPurchaseAnswer } from "@keelson/alibi/verify";
import { useEffect, useMemo, useState } from "react";
import { loader, verifier } from "./verifier.ts";

const EXPLORER = "https://sepolia.arbiscan.io";
const CHAIN_ID = 421614;

type Step<T> =
  | { state: "running" }
  | { state: "done"; value: T; ms: number }
  | { state: "error"; reason: string };

type Tone = "pass" | "fail" | "warn" | "run";

const DOT: Record<Tone, string> = {
  pass: "bg-ok",
  fail: "bg-vermilion",
  warn: "bg-warn",
  run: "bg-graphite motion-safe:animate-pending",
};
const TONE: Record<Tone, string> = {
  pass: "text-ok",
  fail: "text-vermilion-deep",
  warn: "text-warn",
  run: "text-muted-foreground",
};
const WORD: Record<Tone, string> = {
  pass: "Verified",
  fail: "Failed",
  warn: "Unreachable",
  run: "Verifying…",
};

/** The public inputs, in the order the circuit takes them. */
const INPUTS = [
  "Mandate commitment",
  "Amount",
  "Currency",
  "Category",
  "Store",
  "Time",
  "Cart",
  "Agent operator",
  "Mandate the user signed",
  "Registered-user set",
];

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const utc = (d: Date) =>
  `${d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;

function money(minor: bigint, currency: string | undefined): string {
  if (!currency) return `${minor} (minor units)`;
  const f = new Intl.NumberFormat("en-US", { style: "currency", currency });
  const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
  return f.format(Number(minor) / 10 ** digits);
}

async function timed<T>(run: () => Promise<T>): Promise<Step<T>> {
  const started = performance.now();
  try {
    const value = await run();
    return { state: "done", value, ms: performance.now() - started };
  } catch (err) {
    return { state: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}

function Row({
  tone,
  title,
  who,
  ms,
  children,
}: {
  tone: Tone;
  title: string;
  who: string;
  ms?: number;
  children?: React.ReactNode;
}) {
  return (
    <li className="grid grid-cols-[1rem_1fr_auto] items-start gap-x-3 py-2.5" data-anon-step>
      <span className={`mt-1.5 size-2 rounded-full ${DOT[tone]}`} aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-[15px]">{title}</p>
        {children && <div className="mt-0.5 text-sm text-muted-foreground">{children}</div>}
      </div>
      <div className="text-right">
        <p className={`text-sm ${TONE[tone]}`} data-status={tone}>
          {WORD[tone]}
        </p>
        <p className="font-mono text-xs text-muted-foreground tabular-nums">
          {who}
          {ms !== undefined && ` · ${ms < 10 ? ms.toFixed(1) : ms.toFixed(0)} ms`}
        </p>
      </div>
    </li>
  );
}

const ExternalLink = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a
    className="font-mono text-xs underline decoration-border underline-offset-4 hover:text-graphite hover:decoration-graphite"
    href={href}
    target="_blank"
    rel="noopener"
  >
    {children}
  </a>
);

/**
 * The purchase's composed C1 and C3 proof: bound to the Alibi on the page, verified with bb.js in
 * this browser, then by the deployed verifier in one `eth_call`, with its registered-user root read
 * from `RegisteredUserSet`. Renders nothing for a purchase without one.
 */
export function Anonymous({ alibi, rpc }: { alibi: AnyAlibi; rpc: string | undefined }) {
  const id = alibi.alibi_id;
  const [proof, setProof] = useState<AnonymousPurchase | null | { error: string }>();
  const [local, setLocal] = useState<Step<boolean>>({ state: "running" });
  const [chain, setChain] = useState<Step<AnonymousPurchaseAnswer>>({ state: "running" });
  const [lib, setLib] = useState<Awaited<typeof verifier>>();

  useEffect(() => {
    void verifier.then(setLib);
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    setProof(undefined);
    loader
      .then(({ anonymousPurchaseOf }) => anonymousPurchaseOf(id, ctl.signal))
      .then(setProof, (err: unknown) => {
        if (!ctl.signal.aborted) setProof({ error: (err as Error).message });
      });
    return () => ctl.abort();
  }, [id]);

  const p = proof && !("error" in proof) ? proof : undefined;

  useEffect(() => {
    if (!p) return;
    let live = true;
    setLocal({ state: "running" });
    void timed(async () => (await verifier).verifyC1C3(p.proof, p.public_inputs)).then(
      (s) => live && setLocal(s),
    );
    return () => {
      live = false;
    };
  }, [p]);

  useEffect(() => {
    if (!p) return;
    let live = true;
    setChain({ state: "running" });
    void timed(async () =>
      (await verifier).readAnonymousPurchase(
        p.verifier?.chain_id ?? CHAIN_ID,
        p,
        rpc ? { rpc: { 421614: rpc } } : {},
      ),
    ).then((s) => live && setChain(s));
    return () => {
      live = false;
    };
  }, [p, rpc]);

  const binding = useMemo(
    () => (p && lib ? lib.bindAnonymousPurchase(lib.v1Shape(alibi), p.public_inputs) : undefined),
    [p, lib, alibi],
  );

  if (proof === null) return null;
  if (proof === undefined || !lib) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Looking for an anonymous proof of this purchase…
      </p>
    );
  }
  if ("error" in proof) {
    return (
      <p className="rounded-[10px] border border-warn px-4 py-3 text-sm text-warn" role="status">
        {proof.error}
      </p>
    );
  }

  const facts = lib.anonymousPurchaseFacts(proof.public_inputs);
  const bound = binding?.mismatched.length === 0;
  const answer = chain.state === "done" ? chain.value : undefined;
  const root = answer?.root;
  const rootHeld = root ? root.publishedAt > 0 && root.revokedAt === 0 : false;
  const rootLogged = Boolean(root?.log);

  const tones: Tone[] = [
    bound ? "pass" : "fail",
    local.state === "running" ? "run" : local.state === "done" && local.value ? "pass" : "fail",
    chain.state === "running"
      ? "run"
      : chain.state === "error"
        ? "warn"
        : answer?.accepted
          ? "pass"
          : "fail",
    chain.state === "running"
      ? "run"
      : chain.state === "error"
        ? "warn"
        : rootHeld && (rootLogged || !proof.root_tx)
          ? "pass"
          : "fail",
  ];
  const done = tones.filter((t) => t !== "run").length;
  const overall: Tone = tones.includes("fail")
    ? "fail"
    : tones.includes("run")
      ? "run"
      : tones.includes("warn")
        ? "warn"
        : "pass";
  const verifierAddress = proof.verifier?.address;
  const category = facts.category
    ? (lib.CATEGORY_LABELS[facts.category]?.split(" > ").at(-1) ?? facts.category)
    : "Unknown";

  return (
    <section
      aria-labelledby="anonymous-title"
      className={`rounded-[14px] border bg-bone-2 p-6 ${overall === "fail" ? "border-vermilion" : "border-border"}`}
      data-anonymous={overall}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 id="anonymous-title" className="text-2xl font-semibold tracking-tight">
          {overall === "fail"
            ? "The anonymous proof does not hold"
            : "Bought for a registered user, without revealing who"}
        </h2>
        <p className={`text-sm ${TONE[overall]}`} role="status" aria-live="polite">
          {overall === "run"
            ? `Verifying the proof: ${done} of ${tones.length} checks done`
            : overall === "pass"
              ? "Proof verified"
              : overall === "warn"
                ? "Verified in your browser; the chain could not be read"
                : "Proof failed"}
        </p>
      </div>
      <p className="mt-2 max-w-prose text-pretty text-muted-foreground">
        One zero-knowledge proof shows that a person registered with Keelson signed this
        purchase&apos;s mandate with their passkey, and that the cart stayed within that
        mandate&apos;s limits. It reveals neither the person, their passkey, nor what else the
        mandate allows.
      </p>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        {[
          ["Amount", money(facts.amount.minor, facts.amount.currency)],
          ["Category", category],
          ["Countersigned", utc(facts.at)],
          [
            "Hidden among",
            root?.size ? `${root.size.toLocaleString("en-US")} registered users` : "Reading…",
          ],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
              {k}
            </dt>
            <dd className="mt-0.5 text-[15px] tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>

      <ul className="mt-5 divide-y divide-border border-y border-border">
        <Row tone={tones[0] as Tone} title="Proof is of this purchase" who="This page">
          {bound
            ? `The mandate, time, cart, agent and signed mandate it names are this Alibi's (${binding?.bound.length} of ${proof.public_inputs.length} inputs; the receipt does not carry the rest).`
            : `It names another ${binding?.mismatched.map((i) => INPUTS[i]?.toLowerCase()).join(", ")} than this Alibi.`}
        </Row>
        <Row
          tone={tones[1] as Tone}
          title="Verified in your browser"
          who="bb.js"
          {...(local.state === "done" ? { ms: local.ms } : {})}
        >
          {local.state === "error"
            ? local.reason
            : "UltraHonk, against the verification key pinned in this page's code."}
        </Row>
        <Row
          tone={tones[2] as Tone}
          title="Accepted by the on-chain verifier"
          who="Arbitrum"
          {...(chain.state === "done" ? { ms: chain.ms } : {})}
        >
          {chain.state === "error" ? (
            chain.reason
          ) : (
            <>
              <span className="block">
                One <span className="font-mono text-xs">eth_call</span> to{" "}
                <span className="font-mono text-xs">verify(proof, inputs)</span>
                {answer &&
                  ` through ${new URL(answer.rpc).host}${answer.custom ? " (your RPC)" : ""}`}
                .
              </span>
              {verifierAddress && (
                <ExternalLink href={`${EXPLORER}/address/${verifierAddress}#code`}>
                  AnonymousPurchaseVerifier {short(verifierAddress)}
                </ExternalLink>
              )}
            </>
          )}
        </Row>
        <Row tone={tones[3] as Tone} title="Registered-user set published on chain" who="Arbitrum">
          {chain.state === "error" ? (
            chain.reason
          ) : (
            <>
              <span className="block">
                {root && !rootHeld
                  ? `RegisteredUserSet does not hold root ${short(facts.userSetRoot)}${root.revokedAt ? ": it was revoked" : ""}.`
                  : root
                    ? `Root ${short(facts.userSetRoot)}, ${root.size.toLocaleString("en-US")} users, published ${utc(new Date(root.publishedAt * 1000))}.`
                    : `Root ${short(facts.userSetRoot)}.`}
              </span>
              {proof.root_tx && (
                <ExternalLink href={`${EXPLORER}/tx/${proof.root_tx}`}>
                  Published in {short(proof.root_tx)}
                </ExternalLink>
              )}
            </>
          )}
        </Row>
      </ul>

      <details className="group mt-4">
        <summary className="w-fit cursor-pointer text-sm text-muted-foreground hover:text-graphite">
          The proof and its public inputs
        </summary>
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          {Math.round((proof.proof.length * 3) / 4 / 1024)} KB · UltraHonk · C1 and C3 verified by
          recursion
        </p>
        <dl className="mt-2 divide-y divide-border border-y border-border">
          {proof.public_inputs.map((x, i) => (
            <div
              key={INPUTS[i]}
              className="grid gap-x-4 py-2 text-sm sm:grid-cols-[12rem_1fr]"
              data-input={i}
            >
              <dt className="text-muted-foreground">
                {INPUTS[i]}
                {binding?.bound.includes(i) && <span className="ml-2 text-ok">in the Alibi</span>}
              </dt>
              <dd className="break-all font-mono text-xs">{x}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}
