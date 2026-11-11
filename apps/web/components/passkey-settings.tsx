"use client";

import { Badge } from "@keelson/ui/components/badge";
import { Button } from "@keelson/ui/components/button";
import { Fingerprint } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ApiError, del, get } from "../lib/api";
import { authClient } from "../lib/auth";
import { addPasskey, localPasskeys, type Passkey } from "../lib/passkeys";
import { AppShell } from "./app-shell";
import { ErrorNotice } from "./notice";
import { PageHead } from "./page-head";

const added = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

/** The signed-in user's passkeys: list them, add one on this device, remove any but the last. */
export function PasskeySettings() {
  const router = useRouter();
  const session = authClient.useSession();
  const [passkeys, setPasskeys] = useState<Passkey[]>();
  const [busy, setBusy] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  // Set when the session is too old for this action: sign in again, then add or remove.
  const [stale, setStale] = useState<"add" | "remove">();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    const r = await get<{ passkeys: Passkey[] }>("/v1/passkeys");
    setPasskeys(r.passkeys);
  }, []);

  useEffect(() => {
    if (session.isPending) return;
    if (!session.data) {
      router.replace("/");
      return;
    }
    load().catch((e) => setError(e instanceof Error ? e.message : "Could not load passkeys."));
  }, [session.isPending, session.data, router, load]);

  const add = async () => {
    setBusy("add");
    setError(undefined);
    const res = await addPasskey("Keelson");
    setBusy(undefined);
    if (!res.ok) {
      if (res.stale) setStale("add");
      else setError(res.message);
      return;
    }
    setStale(undefined);
    await load();
  };

  const reauthWithPasskey = async () => {
    setBusy("reauth");
    setError(undefined);
    const res = await authClient.signIn.passkey();
    setBusy(undefined);
    if (res.error) {
      setError(res.error.message ?? "No passkey signed in.");
      return;
    }
    if (stale === "add") await add();
    else setStale(undefined);
  };

  const reauthWithPayPal = async () => {
    setBusy("reauth");
    const { error } = await authClient.signIn.social({
      provider: "paypal",
      callbackURL: `${location.origin}/passkeys/`,
    });
    if (error) {
      setError(error.message ?? "PayPal sign-in could not start.");
      setBusy(undefined);
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    setError(undefined);
    try {
      await del(`/v1/passkeys/${encodeURIComponent(id)}`);
      setConfirming(undefined);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.slug === "session-not-fresh") {
        setStale("remove");
        setConfirming(undefined);
        return;
      }
      setError(e instanceof Error ? e.message : "The passkey was not removed.");
    } finally {
      setBusy(undefined);
    }
  };

  // A Judge Mode tenant has no PayPal account; PayPal would sign in someone else.
  const judge = (session.data?.user as { isAnonymous?: boolean | null } | undefined)?.isAnonymous;
  const here = new Set(passkeys ? localPasskeys() : []);
  const last = passkeys?.length === 1;

  return (
    <AppShell>
      <div className="grid max-w-2xl gap-6">
        <PageHead title="Passkeys" line="Each one signs you in and signs your mandates." />

        {passkeys === undefined ? (
          error ? null : (
            <p role="status" className="sr-only">
              Loading…
            </p>
          )
        ) : (
          <ul className="grid gap-1 rounded-3xl border bg-card p-3" aria-label="Your passkeys">
            {passkeys.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl px-3 py-3"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-bone-2">
                  <Fingerprint className="size-5" aria-hidden="true" />
                </span>
                <div className="mr-auto grid gap-0.5">
                  <span className="flex items-center gap-2 font-medium">
                    {p.name ?? "Passkey"}
                    {here.has(p.credentialId) ? <Badge variant="outline">This device</Badge> : null}
                  </span>
                  <span className="font-mono text-muted-foreground text-xs">
                    {p.createdAt ? `Added ${added.format(new Date(p.createdAt))}` : "Added earlier"}
                  </span>
                </div>
                {confirming === p.id ? (
                  <div className="flex gap-2">
                    <Button disabled={busy !== undefined} onClick={() => remove(p.id)}>
                      {busy === p.id ? "Removing…" : "Remove"}
                    </Button>
                    <Button variant="outline" onClick={() => setConfirming(undefined)}>
                      Keep
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    disabled={last || busy !== undefined}
                    title={last ? "Add another passkey before removing this one." : undefined}
                    onClick={() => setConfirming(p.id)}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {stale ? (
          <div className="grid gap-3 rounded-3xl border bg-card p-5">
            <p className="text-pretty">
              {judge
                ? "To change your passkeys, confirm it's you: sign in again with a passkey you have."
                : "To change your passkeys, confirm it's you: sign in again with a passkey you have, or with PayPal."}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button onClick={reauthWithPasskey} disabled={busy !== undefined}>
                {busy === "reauth" ? "Waiting for your passkey…" : "Use a passkey"}
              </Button>
              {judge ? null : (
                <Button variant="outline" onClick={reauthWithPayPal} disabled={busy !== undefined}>
                  Continue with PayPal
                </Button>
              )}
            </div>
          </div>
        ) : (
          <Button
            size="lg"
            onClick={add}
            disabled={passkeys === undefined || busy !== undefined}
            className="h-12 rounded-xl sm:w-fit"
          >
            {busy === "add" ? "Waiting for your device…" : "Add a passkey on this device"}
          </Button>
        )}
        {error ? <ErrorNotice>{error}</ErrorNotice> : null}
      </div>
    </AppShell>
  );
}
