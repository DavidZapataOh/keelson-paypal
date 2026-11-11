"use client";

import { Button } from "@keelson/ui/components/button";
import { useEffect, useState } from "react";
import { ApiError, get } from "../lib/api";
import { VERIFY } from "../lib/config";

/** `GET /v1/anonymous-purchases/{id}`: public. */
interface AnonymousPurchase {
  user_set_root: string;
  public_inputs: string[];
  root_tx?: string;
}

/** Composing follows the Alibi by about fifteen seconds; past this, a missing proof will not come. */
const COMPOSING_MS = 10 * 60_000;

type State =
  | { kind: "loading" }
  | { kind: "proven"; users: number | null; rootTx: string | undefined }
  | { kind: "absent" }
  | { kind: "error"; message: string };

/**
 * Whether the purchase carries the one zero-knowledge proof that a registered user signed its
 * mandate and the cart stayed within it, without naming the user; and a link to verify it.
 */
export function AnonymousProof({ id, createdAt }: { id: string; createdAt: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-reads on demand.
  useEffect(() => {
    let live = true;
    get<AnonymousPurchase>(`/v1/anonymous-purchases/${encodeURIComponent(id)}`)
      .then(async (p) => {
        const root = await get<{ size: number }>(`/v1/user-set/roots/${p.user_set_root}`).catch(
          () => null,
        );
        if (live) setState({ kind: "proven", users: root?.size ?? null, rootTx: p.root_tx });
      })
      .catch((err: unknown) => {
        if (!live) return;
        setState(
          err instanceof ApiError && err.status === 404
            ? { kind: "absent" }
            : { kind: "error", message: (err as Error).message },
        );
      });
    return () => {
      live = false;
    };
  }, [id, attempt]);

  const composing =
    state.kind === "absent" && Date.now() - new Date(createdAt).getTime() < COMPOSING_MS;

  return (
    <section
      className="grid gap-3 border-t pt-5"
      aria-labelledby="anonymous-proof"
      data-anonymous-proof={state.kind}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 id="anonymous-proof" className="font-medium">
          Anonymous proof
        </h3>
        <span
          className={`flex items-center gap-1.5 text-sm ${state.kind === "proven" ? "text-ok" : "text-muted-foreground"}`}
          role="status"
        >
          <span
            aria-hidden="true"
            className={`size-2 rounded-full ${
              state.kind === "proven"
                ? "bg-ok"
                : composing || state.kind === "loading"
                  ? "bg-foreground motion-safe:animate-pending"
                  : "bg-border"
            }`}
          />
          {state.kind === "proven"
            ? "Proven"
            : state.kind === "loading"
              ? "Reading…"
              : composing
                ? "Composing"
                : state.kind === "error"
                  ? "Unavailable"
                  : "None"}
        </span>
      </div>
      {state.kind === "proven" ? (
        <>
          <p className="text-muted-foreground text-sm">
            One zero-knowledge proof shows that a registered user signed this mandate and that the
            cart stayed within it, without saying who
            {state.users ? `: you are one of ${state.users.toLocaleString("en-US")} users` : ""}.
            Anyone can check it, in a browser or against the verifier on Arbitrum.
          </p>
          <Button variant="outline" asChild className="w-fit">
            <a href={`${VERIFY}/a/${id}?proof=anonymous`} target="_blank" rel="noopener">
              Verify the anonymous proof
            </a>
          </Button>
        </>
      ) : composing ? (
        <div className="grid gap-2">
          <p className="text-muted-foreground text-sm">
            Keelson is composing the cart&apos;s proof with your mandate&apos;s into one. It takes
            about fifteen seconds after the Alibi is sealed.
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="w-fit"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Check again
          </Button>
        </div>
      ) : state.kind === "absent" ? (
        <p className="text-muted-foreground text-sm">
          This purchase has no anonymous proof. Its Alibi still proves everything else.
        </p>
      ) : state.kind === "error" ? (
        <p className="text-muted-foreground text-sm">{state.message}</p>
      ) : null}
    </section>
  );
}
