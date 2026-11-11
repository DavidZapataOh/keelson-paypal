"use client";

import { Button } from "@keelson/ui/components/button";
import { KeyRound, Loader2 } from "lucide-react";
import { useState } from "react";
import { authClient } from "../lib/auth";
import { ErrorNotice } from "./notice";
import { OnboardingFrame } from "./onboarding/frame";
import { GateScene } from "./onboarding/gate-scene";

/**
 * Step one: connect the PayPal account the agent will pay with. Pages a signed-out visitor reaches
 * mid-task (an agent's approval link, an app's sign-in) say why and come back to `returnTo`.
 */
export function Welcome({
  title = "Connect your PayPal",
  line = "Your agent pays with it. Keelson checks every cart first.",
  returnTo,
}: {
  title?: string;
  line?: string;
  returnTo?: string | undefined;
} = {}) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<"paypal" | "passkey">();

  const paypal = async () => {
    setBusy("paypal");
    setError(undefined);
    const { error } = await authClient.signIn.social({
      provider: "paypal",
      callbackURL: returnTo ?? `${location.origin}/`,
    });
    if (error) {
      setError(error.message ?? "PayPal sign-in could not start.");
      setBusy(undefined);
    }
  };

  const passkey = async () => {
    setBusy("passkey");
    setError(undefined);
    const res = await authClient.signIn.passkey();
    if (res.error) {
      setError(res.error.message ?? "No passkey signed in.");
      setBusy(undefined);
      return;
    }
    location.assign(returnTo ?? "/");
  };

  return (
    <OnboardingFrame
      step="PayPal"
      stage={<GateScene />}
      action={
        <div className="grid gap-2">
          <Button
            size="lg"
            onClick={paypal}
            disabled={busy !== undefined}
            className="h-13 w-full rounded-xl text-base"
          >
            {busy === "paypal" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {busy === "paypal" ? "Opening PayPal" : "Continue with PayPal"}
          </Button>
          <Button
            size="lg"
            variant="ghost"
            onClick={passkey}
            disabled={busy !== undefined}
            className="h-12 w-full rounded-xl"
          >
            <KeyRound aria-hidden="true" />
            {busy === "passkey" ? "Waiting for your passkey" : "I have a passkey"}
          </Button>
          <p className="mt-4 hidden text-muted-foreground text-xs leading-relaxed lg:block">
            PayPal sandbox: no real money moves. Keelson is an independent project, not affiliated
            with or endorsed by PayPal.
          </p>
        </div>
      }
    >
      <div className="grid gap-3">
        <h1 className="text-balance font-semibold text-[1.75rem] leading-[1.1] tracking-[-0.025em] sm:text-[2rem]">
          {title}
        </h1>
        <p className="text-pretty text-lg text-muted-foreground leading-snug">{line}</p>
      </div>
      {error ? (
        <div className="mt-6">
          <ErrorNotice>{error}</ErrorNotice>
        </div>
      ) : null}
    </OnboardingFrame>
  );
}
