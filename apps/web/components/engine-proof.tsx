"use client";

import { CopyValue } from "@keelson/ui/components/copy-value";
import { DataItem, DataList } from "@keelson/ui/components/data-list";
import { useEffect, useState } from "react";
import { ApiError, get } from "../lib/api";

/** `GET /v1/engine-proofs/{id}`: public. */
export interface EngineProofStatus {
  purchase_id: string;
  status: "proven" | "proving" | "failed";
  countersign_eval_hash: string;
  countersign_digest: string;
  proof: {
    eval_hash: string;
    matches: boolean;
    vkey: string;
    sp1_version: string;
    cycles: number;
    prove_ms: number;
    proof_bytes: number;
    verifier: { chain_id: number; address: string };
    tx: string;
    explorer_url: string | null;
    gas_used: string;
    proven_at: string;
  } | null;
  /** Queued slashes `EngineProofCourt` vetoed with this proof. */
  contests: { dispute_id: string; field_id: number; tx: string; explorer_url: string | null }[];
}

const millions = (n: number) => `${(n / 1_000_000).toFixed(1)}M`;
const minutes = (ms: number) =>
  ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

function Check({ ok }: { ok: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className="size-3 shrink-0">
      {ok ? (
        <path
          d="m2.5 6.25 2.25 2.25 4.75-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path d="M6 1.5 10.5 10h-9Z" fill="currentColor" />
      )}
    </svg>
  );
}

/**
 * The SP1 proof of a disputed purchase's engine evaluation: the engine's canonicalizer and Cedar
 * evaluation ran again in the SP1 zkVM, gave the `evalHash` both TEEs signed, and the Groth16
 * proof was verified on chain. Renders nothing for a purchase that is not disputed.
 */
export function EngineProof({
  purchaseId,
  compact = false,
}: {
  purchaseId: string;
  compact?: boolean;
}) {
  const [p, setP] = useState<EngineProofStatus | null | { error: string }>();
  useEffect(() => {
    let live = true;
    get<EngineProofStatus>(`/v1/engine-proofs/${encodeURIComponent(purchaseId)}`).then(
      (r) => live && setP(r),
      (e: Error) =>
        live && setP(e instanceof ApiError && e.status === 404 ? null : { error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [purchaseId]);
  if (!p || "error" in p) return null;

  const proof = p.proof;
  const failed = p.status === "failed";
  const heading = (
    <p className="flex items-center gap-1.5 font-medium">
      <span
        className={
          proof
            ? proof.matches
              ? "text-ok"
              : "text-warn"
            : failed
              ? "text-warn"
              : "text-muted-foreground"
        }
      >
        <Check ok={proof ? proof.matches : !failed} />
      </span>
      {proof
        ? proof.matches
          ? "Engine re-proven in SP1, verified on chain"
          : "The SP1 proof does not match the countersign"
        : failed
          ? "No SP1 proof of the engine evaluation was recorded"
          : "Re-proving the engine evaluation in SP1"}
    </p>
  );

  return (
    <section aria-label="SP1 proof of the engine evaluation" className="grid gap-2 text-sm">
      {heading}
      <p className="text-muted-foreground text-xs">
        {proof
          ? "The same canonicalizer and Cedar evaluation the TEEs ran, executed again in the SP1 zkVM over this purchase's inputs. Its result hashes to the evalHash both TEEs signed."
          : failed
            ? "The dispute is decided on the TEEs' signed verdict alone; the zkVM re-run did not finish."
            : "The same canonicalizer and Cedar evaluation the TEEs ran is being executed in the SP1 zkVM. The Groth16 proof takes a few minutes."}
      </p>
      {proof ? (
        <DataList layout={compact ? "stacked" : "row"} className={compact ? "gap-2" : undefined}>
          <DataItem label="evalHash">
            <span className="inline-flex items-center gap-1.5">
              <CopyValue value={proof.eval_hash} label="evalHash" short />
              <span className={proof.matches ? "text-ok text-xs" : "text-warn text-xs"}>
                {proof.matches ? "matches the TEEs" : "differs"}
              </span>
            </span>
          </DataItem>
          <DataItem label="Proof">
            <span className="tabular-nums">
              Groth16 · {millions(proof.cycles)} cycles · {proof.proof_bytes} B ·{" "}
              {minutes(proof.prove_ms)}
            </span>
          </DataItem>
          <DataItem label="Program key">
            <CopyValue value={proof.vkey} label="SP1 program verifying key" short />
          </DataItem>
          <DataItem label="Bond">
            {p.contests.length === 0 ? (
              <span className="text-muted-foreground">
                Guarded: a slash for a field this evaluation passed is vetoed on chain
              </span>
            ) : (
              <span className="grid gap-1">
                {p.contests.map((c) => (
                  <span key={c.dispute_id} className="inline-flex items-center gap-1.5">
                    <span className="text-ok">
                      <Check ok />
                    </span>
                    Slash vetoed by the proof ·{" "}
                    {c.explorer_url ? (
                      <a className="underline" href={c.explorer_url} target="_blank" rel="noopener">
                        <span className="font-mono">{`${c.tx.slice(0, 8)}…${c.tx.slice(-4)}`}</span>{" "}
                        ↗<span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    ) : (
                      <CopyValue value={c.tx} label="Transaction" short />
                    )}
                  </span>
                ))}
              </span>
            )}
          </DataItem>
          <DataItem label="Verified on chain">
            {proof.explorer_url ? (
              <a className="underline" href={proof.explorer_url} target="_blank" rel="noopener">
                <span className="font-mono">{`${proof.tx.slice(0, 8)}…${proof.tx.slice(-4)}`}</span>{" "}
                ↗<span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : (
              <CopyValue value={proof.tx} label="Transaction" short />
            )}
          </DataItem>
        </DataList>
      ) : null}
    </section>
  );
}
