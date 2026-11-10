"use client";

import { Button } from "@keelson/ui/components/button";
import { useState } from "react";
import { authClient } from "../lib/auth";
import { ErrorNotice, Eyebrow } from "./notice";
import { Story } from "./story";

/** The first screen: what Keelson does for you, then sign in. */
export function Welcome() {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<"paypal" | "passkey">();

  const paypal = async () => {
    setBusy("paypal");
    const { error } = await authClient.signIn.social({
      provider: "paypal",
      callbackURL: `${location.origin}/`,
    });
    if (error) {
      setError(error.message ?? "PayPal sign-in could not start.");
      setBusy(undefined);
    }
  };

  const passkey = async () => {
    setBusy("passkey");
    const res = await authClient.signIn.passkey();
    if (res.error) {
      setError(res.error.message ?? "No passkey signed in.");
      setBusy(undefined);
      return;
    }
    location.assign("/");
  };

  return (
    <div className="grid gap-12 pt-4 md:grid-cols-[1.05fr_1fr] md:items-center md:gap-16 md:pt-12">
      <div className="grid content-start gap-8">
        <div className="grid gap-4">
          <Eyebrow>Proof before payment</Eyebrow>
          <h1 className="text-balance font-semibold text-4xl leading-[1.02] tracking-[-0.035em] sm:text-5xl">
            If your agent goes outside what you signed, someone answers, and it isn't you.
          </h1>
          <p className="max-w-prose text-pretty text-lg text-muted-foreground">
            Tell your shopping agent what it may buy. Keelson checks every cart against it before
            PayPal pays, and keeps an Alibi of each purchase that anyone can verify.
          </p>
        </div>
        <div className="grid gap-3 sm:max-w-sm">
          <Button size="lg" onClick={paypal} disabled={busy !== undefined}>
            {busy === "paypal" ? "Opening PayPal…" : "Continue with PayPal"}
          </Button>
          <Button size="lg" variant="outline" onClick={passkey} disabled={busy !== undefined}>
            {busy === "passkey" ? "Waiting for your passkey…" : "Sign in with a passkey"}
          </Button>
          <p className="text-muted-foreground text-sm">PayPal sandbox. No real money moves.</p>
        </div>
        {error ? <ErrorNotice>{error}</ErrorNotice> : null}
      </div>
      <Story />
      <p className="text-muted-foreground text-xs md:col-span-2">
        Keelson is an independent project. Not affiliated with or endorsed by PayPal.
      </p>
    </div>
  );
}
