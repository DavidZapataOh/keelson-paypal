import type { AlibiBundle, AlibiReceipt } from "@keelson/alibi";
import { useEffect, useState } from "react";
import { verifier } from "./verifier.ts";

type Hex = `0x${string}`;

const API = "https://api.keelson.finance";

interface EngineProofStatus {
  status: "proven" | "proving" | "failed";
  countersign_eval_hash: Hex;
  countersign_digest: Hex;
  proof: {
    eval_hash: Hex;
    public_values: Hex;
    proof: Hex;
    vkey: Hex;
    cycles: number;
    proof_bytes: number;
    verifier: { chain_id: number; address: Hex };
    tx: Hex;
    explorer_url: string | null;
  } | null;
}

type State =
  | { kind: "none" }
  | { kind: "proving" }
  | { kind: "checking" }
  | { kind: "pass"; p: NonNullable<EngineProofStatus["proof"]>; ms: number }
  | { kind: "fail"; reason: string; p?: NonNullable<EngineProofStatus["proof"]> }
  | { kind: "unreachable"; reason: string }
  | { kind: "missing"; reason: string };

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

/**
 * For a disputed purchase, checks the SP1 proof that the engine's canonicalizer and Cedar
 * evaluation, run again in the zkVM, give the `evalHash` this Alibi's countersign carries: the
 * proof is verified in an `eth_call` to `EngineProofVerifier`, which goes through Succinct's SP1
 * verifier gateway, and what it commits to is compared with the Alibi itself.
 */
export function EngineProof({
  alibi,
  rpc,
}: {
  alibi: AlibiBundle | AlibiReceipt;
  rpc: string | undefined;
}) {
  const [state, setState] = useState<State>({ kind: "none" });
  useEffect(() => {
    let live = true;
    const set = (s: State) => live && setState(s);
    (async () => {
      const res = await fetch(`${API}/v1/engine-proofs/${encodeURIComponent(alibi.alibi_id)}`);
      if (res.status === 404) return set({ kind: "none" });
      if (!res.ok) return set({ kind: "unreachable", reason: `The API answered ${res.status}.` });
      const e = (await res.json()) as EngineProofStatus;
      if (!e.proof) {
        return set(
          e.status === "failed"
            ? { kind: "missing", reason: "No SP1 proof of this evaluation was recorded." }
            : { kind: "proving" },
        );
      }
      const p = e.proof;
      set({ kind: "checking" });
      // A full Alibi states its own countersign; a public receipt leaves the API's word.
      const tee = "tee" in alibi ? alibi.tee : undefined;
      const evalHash = (tee?.countersign.evalHash ?? e.countersign_eval_hash).toLowerCase();
      const digest = (tee?.digest ?? e.countersign_digest).toLowerCase();
      const started = performance.now();
      const { verifyEngineProof } = await verifier;
      const answer = await verifyEngineProof(
        p.verifier.chain_id,
        p.public_values,
        p.proof,
        rpc ? { rpc: { [p.verifier.chain_id]: rpc } } : {},
      );
      const ms = performance.now() - started;
      if (!answer.proven)
        return set({ kind: "fail", reason: "The verifier rejects the proof.", p });
      if (answer.proven.evalHash.toLowerCase() !== evalHash) {
        return set({ kind: "fail", reason: "The proven evalHash is not the countersign's.", p });
      }
      if (answer.proven.countersignDigest.toLowerCase() !== digest) {
        return set({ kind: "fail", reason: "The proof is of another countersign.", p });
      }
      set({ kind: "pass", p, ms });
    })().catch((err: unknown) => set({ kind: "unreachable", reason: (err as Error).message }));
    return () => {
      live = false;
    };
  }, [alibi, rpc]);

  if (state.kind === "none") return null;
  const tone =
    state.kind === "pass"
      ? { dot: "bg-ok", text: "text-ok", word: "Pass" }
      : state.kind === "fail"
        ? { dot: "bg-vermilion", text: "text-vermilion-deep", word: "Fail" }
        : state.kind === "unreachable" || state.kind === "missing"
          ? {
              dot: "bg-warn",
              text: "text-warn",
              word: state.kind === "missing" ? "Not proven" : "Unreachable",
            }
          : { dot: "bg-border", text: "text-muted-foreground", word: "Pending" };
  const p = "p" in state ? state.p : undefined;

  return (
    <section aria-labelledby="engine-proof" className="space-y-3" data-check="zk.engine">
      <h2 id="engine-proof" className="font-semibold text-lg">
        Dispute re-check
      </h2>
      <div className="grid grid-cols-[1rem_1fr_auto] items-start gap-x-3 border-border border-y py-2.5">
        <span className={`mt-1.5 size-2 rounded-full ${tone.dot}`} aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-[15px]">Engine evaluation re-proven in SP1</p>
          <p className="mt-0.5 text-muted-foreground text-sm">
            {state.kind === "proving"
              ? "This purchase is disputed: the engine's canonicalizer and Cedar evaluation are being run again in the SP1 zkVM. The Groth16 proof takes a few minutes."
              : state.kind === "checking"
                ? "Verifying the Groth16 proof on Arbitrum through the SP1 verifier gateway…"
                : state.kind === "pass"
                  ? `The same canonicalizer and Cedar evaluation, run in the SP1 zkVM, give this Alibi's evalHash ${short(state.p.eval_hash)}, and the proof verifies on chain.`
                  : state.reason}
          </p>
          {p && (
            <p className="mt-0.5 font-mono text-muted-foreground text-xs">
              Groth16 · {(p.cycles / 1e6).toFixed(1)}M cycles · {p.proof_bytes} B · program{" "}
              {short(p.vkey)}
            </p>
          )}
          {p?.explorer_url && (
            <a
              className="mt-0.5 inline-block font-mono text-muted-foreground text-xs underline hover:text-graphite"
              href={p.explorer_url}
              target="_blank"
              rel="noopener"
              data-proof
            >
              Recorded in {short(p.tx)}
            </a>
          )}
        </div>
        <div className="text-right">
          <p className={`text-sm ${tone.text}`} data-status={state.kind}>
            {tone.word}
          </p>
          <p className="font-mono text-muted-foreground text-xs">
            Arbitrum{state.kind === "pass" ? ` · ${state.ms.toFixed(0)} ms` : ""}
          </p>
        </div>
      </div>
    </section>
  );
}
