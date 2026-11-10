import type { AmberReading } from "@keelson/alibi/verify";
import { useEffect, useState } from "react";
import { verifier } from "./verifier.ts";

const FIELD = ["", "size", "color", "unit price", "free returns"] as const;
const EXPLORER = "https://sepolia.arbiscan.io";
const ZERO = /^0x0{64}$/;

type State =
  | { kind: "reading" }
  | { kind: "read"; amber: AmberReading; ms: number }
  | { kind: "failed"; message: string };

function Line({
  tone,
  label,
  status,
  children,
}: {
  tone: "pass" | "fail" | "mute";
  label: string;
  status: string;
  children?: React.ReactNode;
}) {
  const dot = { pass: "bg-ok", fail: "bg-vermilion", mute: "bg-border" }[tone];
  const text = { pass: "text-ok", fail: "text-vermilion-deep", mute: "text-muted-foreground" }[
    tone
  ];
  return (
    <li className="grid grid-cols-[1rem_1fr_auto] items-start gap-x-3 py-2.5">
      <span className={`mt-1.5 size-2 rounded-full ${dot}`} aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-[15px]">{label}</p>
        {children}
      </div>
      <p className={`text-right text-sm ${text}`}>{status}</p>
    </li>
  );
}

const mono = "mt-0.5 break-all font-mono text-xs text-muted-foreground";

/**
 * C2b, for one Alibi: the amber commitment its coverage was locked with on Arbitrum Sepolia and,
 * if `AmberContradictionCourt` convicted it, the proof re-verified in this browser.
 */
export default function Amber({ alibiId, rpc }: { alibiId: string; rpc: string | undefined }) {
  const [state, setState] = useState<State>({ kind: "reading" });
  useEffect(() => {
    let live = true;
    setState({ kind: "reading" });
    const started = performance.now();
    verifier
      .then(({ readAmber }) => readAmber(alibiId, rpc ? { rpc } : {}))
      .then(
        (amber) => live && setState({ kind: "read", amber, ms: performance.now() - started }),
        (err: unknown) =>
          live &&
          setState({ kind: "failed", message: err instanceof Error ? err.message : String(err) }),
      );
    return () => {
      live = false;
    };
  }, [alibiId, rpc]);

  return (
    <section aria-labelledby="amber" data-amber={state.kind}>
      <h3 id="amber" className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
        C2b · Amber contradiction
      </h3>
      {state.kind === "reading" ? (
        <p
          role="status"
          className="mt-1 border-y border-border py-2.5 text-sm text-muted-foreground"
        >
          Reading the coverage and the court on Arbitrum Sepolia…
        </p>
      ) : state.kind === "failed" ? (
        <p role="alert" className="mt-1 border-y border-border py-2.5 text-sm text-warn">
          The chain could not be read: {state.message}
        </p>
      ) : (
        <Reading amber={state.amber} ms={state.ms} />
      )}
    </section>
  );
}

function Reading({ amber, ms }: { amber: AmberReading; ms: number }) {
  const { commitment, conviction: v } = amber;
  const attested = commitment !== null && !ZERO.test(commitment);
  return (
    <>
      <ul className="mt-1 divide-y divide-border border-y border-border">
        <Line
          tone={attested ? "pass" : "mute"}
          label="The operator attested the item in the coverage"
          status={commitment === null ? "No lock found" : attested ? "Attested" : "None"}
        >
          {attested ? (
            <p className={mono}>amberCommitment {commitment}</p>
          ) : (
            <p className="mt-0.5 text-sm text-muted-foreground">
              {commitment === null
                ? "No CoverageLocked event for this Alibi near its purchase."
                : "The coverage was locked without an amber commitment."}
            </p>
          )}
        </Line>
        {v ? (
          <>
            <Line
              tone="fail"
              label={`AmberContradictionCourt convicted the ${FIELD[v.fieldId]}`}
              status="Proven false"
            >
              <p className="mt-0.5 text-sm text-muted-foreground">
                The store's own answer for this SKU, notarized by Keelson's TLSNotary leg, holds
                another {FIELD[v.fieldId]}.{" "}
                <time dateTime={v.provenAt.toISOString()}>
                  {v.provenAt.toISOString().replace("T", " ").slice(0, 19)} UTC
                </time>
              </p>
              <p className={mono}>WebFact {v.webFactDigest}</p>
              <a
                className="mt-0.5 inline-block font-mono text-xs text-muted-foreground underline hover:text-graphite"
                href={`${EXPLORER}/tx/${v.txHash}`}
                target="_blank"
                rel="noopener"
              >
                {v.txHash.slice(0, 10)}…{v.txHash.slice(-8)} on Arbiscan ↗
              </a>
            </Line>
            <Line
              tone={v.proofVerified && v.statementMatches ? "pass" : "fail"}
              label="The C2b proof, verified in this browser"
              status={
                v.proofBytes === null
                  ? "Not readable"
                  : v.proofVerified && v.statementMatches
                    ? "Verified"
                    : "Does not hold"
              }
            >
              <p className="mt-0.5 text-sm text-muted-foreground">
                {v.proofBytes === null
                  ? "The conviction was sent through another contract, so its proof is not in the transaction's input."
                  : `UltraHonk, ${v.proofBytes.toLocaleString("en-US")} bytes, against the pinned key, on the coverage's own commitment and the convicted field.`}
              </p>
            </Line>
          </>
        ) : (
          <Line
            tone={attested ? "pass" : "mute"}
            label="No conviction by AmberContradictionCourt"
            status="Uncontradicted"
          />
        )}
      </ul>
      <p className="mt-2 font-mono text-xs text-muted-foreground">
        Read from the chain in {ms.toFixed(0)} ms
      </p>
    </>
  );
}
