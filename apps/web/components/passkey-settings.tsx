"use client";

import { Badge } from "@keelson/ui/components/badge";
import { Button } from "@keelson/ui/components/button";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { del, get } from "../lib/api";
import { authClient } from "../lib/auth";
import { addPasskey, localPasskeys, type Passkey } from "../lib/passkeys";
import { ErrorNotice, Eyebrow } from "./notice";

const added = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

/** The signed-in user's passkeys: list them, add one on this device, remove any but the last. */
export function PasskeySettings() {
  const router = useRouter();
  const session = authClient.useSession();
  const [passkeys, setPasskeys] = useState<Passkey[]>();
  const [busy, setBusy] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const [stale, setStale] = useState(false);
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
      setStale(res.stale);
      if (!res.stale) setError(res.message);
      return;
    }
    setStale(false);
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
    await add();
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
      setError(e instanceof Error ? e.message : "The passkey was not removed.");
    } finally {
      setBusy(undefined);
    }
  };

  const here = new Set(passkeys ? localPasskeys() : []);
  const last = passkeys?.length === 1;

  return (
    <div className="grid max-w-2xl gap-8">
      <div className="grid gap-3">
        <Eyebrow>Account</Eyebrow>
        <h1 className="text-balance font-semibold text-3xl tracking-[-0.03em]">Passkeys</h1>
        <p className="text-pretty text-muted-foreground">
          Any of your passkeys signs you in and signs your mandates. Add one on each device you sign
          from. You keep at least one.
        </p>
      </div>

      {passkeys === undefined ? (
        error ? null : (
          <p role="status" className="sr-only">
            Loading…
          </p>
        )
      ) : (
        <ul className="divide-y divide-border rounded-lg border">
          {passkeys.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
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
        <div className="grid gap-3 rounded-lg border p-4">
          <p className="text-pretty">
            To add a passkey, confirm it's you: sign in again with a passkey you have, or with
            PayPal.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button onClick={reauthWithPasskey} disabled={busy !== undefined}>
              {busy === "reauth" ? "Waiting for your passkey…" : "Use a passkey"}
            </Button>
            <Button variant="outline" onClick={reauthWithPayPal} disabled={busy !== undefined}>
              Continue with PayPal
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="lg"
          onClick={add}
          disabled={passkeys === undefined || busy !== undefined}
          className="sm:w-fit"
        >
          {busy === "add" ? "Waiting for your device…" : "Add a passkey on this device"}
        </Button>
      )}
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
    </div>
  );
}
