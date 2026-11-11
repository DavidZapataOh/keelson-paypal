"use client";

import { passkeyRegistrationOptions, rememberPaymentPasskey } from "@keelson/mandate/browser";
import { Button } from "@keelson/ui/components/button";
import { Fingerprint, Loader2 } from "lucide-react";
import { useState } from "react";
import { authClient } from "../lib/auth";
import { RiveMoment } from "./brand";
import { ErrorNotice } from "./notice";
import { OnboardingFrame } from "./onboarding/frame";

/** One decision before the first signature: create the passkey that signs for you. */
export function PasskeySetup({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState(false);
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
    setMade(true);
    setTimeout(onDone, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1400);
  };

  return (
    <OnboardingFrame
      step="Sign"
      stage={
        <RiveMoment
          artboard="Passkey"
          play={made}
          className="size-56 sm:size-72"
          still={
            <span className="grid size-28 place-items-center rounded-[28px] bg-card shadow-[0_18px_40px_-24px_rgb(23_24_27/0.45)]">
              <Fingerprint className="size-14" strokeWidth={1.5} aria-hidden="true" />
            </span>
          }
        />
      }
      action={
        <div className="grid grid-cols-[auto_1fr] gap-2">
          <Button size="lg" variant="outline" onClick={onBack} className="h-13 rounded-xl">
            Back
          </Button>
          <Button
            size="lg"
            onClick={add}
            disabled={busy || made}
            className="h-13 rounded-xl text-base"
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {made ? "Passkey ready" : busy ? "Waiting for your device" : "Create passkey"}
          </Button>
        </div>
      }
    >
      <h1 className="text-balance font-semibold text-[1.75rem] leading-[1.1] tracking-[-0.025em] sm:text-[2rem]">
        Sign with Face ID
      </h1>
      <p className="mt-3 text-pretty text-lg text-muted-foreground leading-snug">
        Your passkey signs your rules. It never leaves this device.
      </p>
      {error ? (
        <div className="mt-6">
          <ErrorNotice>{error}</ErrorNotice>
        </div>
      ) : null}
    </OnboardingFrame>
  );
}
