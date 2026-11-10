"use client";

import { passkeyRegistrationOptions, rememberPaymentPasskey } from "@keelson/mandate/browser";
import { Button } from "@keelson/ui/components/button";
import { useState } from "react";
import { authClient } from "../lib/auth";
import { ErrorNotice, Eyebrow } from "./notice";

/** One decision: create the passkey that signs mandates. */
export function PasskeySetup({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const add = async () => {
    setBusy(true);
    setError(undefined);
    const opts = await passkeyRegistrationOptions();
    const res = await authClient.passkey.addPasskey({ name: "Keelson", ...opts });
    setBusy(false);
    if (res.error || !res.data) {
      setError(res.error?.message ?? "The passkey was not created. Try again.");
      return;
    }
    if (opts.authenticatorAttachment === "platform") rememberPaymentPasskey(res.data.credentialID);
    onDone();
  };

  return (
    <div className="grid max-w-xl gap-6">
      <div className="grid gap-3">
        <Eyebrow>Before your first mandate</Eyebrow>
        <h1 className="text-balance font-semibold text-3xl tracking-[-0.03em]">
          Create the passkey that signs for you
        </h1>
        <p className="text-pretty text-muted-foreground">
          Your mandate is only valid with your signature. The passkey stays on your device; Keelson
          keeps only its public key, so nobody can sign a mandate in your name.
        </p>
      </div>
      <ul className="grid gap-2 text-sm">
        <li>Face ID, Touch ID, Windows Hello, your phone or a security key.</li>
        <li>On Chrome, your browser can show the total and the payee as you sign.</li>
      </ul>
      <Button size="lg" onClick={add} disabled={busy} className="sm:w-fit">
        {busy ? "Waiting for your device…" : "Create passkey"}
      </Button>
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
    </div>
  );
}
