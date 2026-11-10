"use client";

import {
  type PasskeyRef,
  prepareSigning,
  type Signing,
  signMandate,
  TERMS,
} from "@keelson/mandate/browser";
import { Button } from "@keelson/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@keelson/ui/components/field";
import { Textarea } from "@keelson/ui/components/textarea";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { ApiError, get, post } from "../lib/api";
import { authClient } from "../lib/auth";
import { deviceId } from "../lib/device";
import type { Compiled } from "../lib/types";
import { LiabilityLegend, MandateCard } from "./mandate-card";
import { ErrorNotice, Eyebrow } from "./notice";
import { PasskeySetup } from "./passkey-setup";

const EXAMPLE = "Running shoes, size 10, under $100, from RunFast, by Friday";
const NO_EVIDENCE = { merchantSignedCheckout: false, zkTlsFields: new Set<never>() };

type Step =
  | { name: "loading" }
  | { name: "passkey" }
  | { name: "write" }
  | { name: "review"; compiled: Compiled; signing?: Signing };

function message(e: unknown): string {
  if (e instanceof ApiError && e.fields.length > 0) {
    return `${e.message} Say more about: ${e.fields.join(", ")}.`;
  }
  if (e instanceof DOMException && e.name === "NotAllowedError") {
    return "The passkey prompt was closed. Nothing was signed.";
  }
  return e instanceof Error ? e.message : "Something went wrong.";
}

export function NewMandate() {
  const router = useRouter();
  const session = authClient.useSession();
  const [step, setStep] = useState<Step>({ name: "loading" });
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const promptId = useId();

  useEffect(() => {
    if (session.isPending) return;
    if (!session.data) {
      router.replace("/");
      return;
    }
    get<{ passkeys: PasskeyRef[] }>("/v1/passkeys")
      .then((r) => setStep(r.passkeys.length > 0 ? { name: "write" } : { name: "passkey" }))
      .catch((e) => setError(message(e)));
  }, [session.isPending, session.data, router]);

  const compile = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const compiled = await post<Compiled>(
        "/v1/mandates/compile",
        { prompt, mode: "autonomous" },
        { "keelson-device": deviceId() },
      );
      setStep({ name: "review", compiled });
      // The commitment and challenge are built now, so the passkey prompt opens on the click.
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const signing = await prepareSigning(
        compiled.mandateDraft,
        salt,
        NO_EVIDENCE,
        compiled.ambiguous,
      );
      setStep({ name: "review", compiled, signing });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const sign = async (signing: Signing) => {
    setBusy(true);
    setError(undefined);
    try {
      const { passkeys } = await get<{ passkeys: PasskeyRef[] }>("/v1/passkeys");
      const assertion = await signMandate(signing.challenge, passkeys, { spc: signing.spc });
      const created = await post<{ id: string }>("/v1/mandates", {
        payloadSd: signing.payloadSd,
        disclosures: signing.disclosures,
        commitment: signing.commitment,
        salt: signing.salt,
        assertion,
      });
      router.push(`/mandate/?id=${created.id}`);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };

  if (step.name === "loading") {
    return error ? (
      <ErrorNotice>{error}</ErrorNotice>
    ) : (
      <p role="status" className="sr-only">
        Loading…
      </p>
    );
  }
  if (step.name === "passkey") return <PasskeySetup onDone={() => setStep({ name: "write" })} />;

  if (step.name === "write") {
    return (
      <form onSubmit={compile} className="grid max-w-2xl gap-6">
        <div className="grid gap-3">
          <Eyebrow>New mandate · 1 of 2</Eyebrow>
          <h1 className="text-balance font-semibold text-3xl tracking-[-0.03em] sm:text-4xl">
            What may your agent buy?
          </h1>
          <p className="text-pretty text-muted-foreground">
            Say what, how much, where and by when. Keelson turns it into a mandate and shows you who
            answers for each part before you sign.
          </p>
        </div>
        <Field>
          <FieldLabel htmlFor={promptId}>Your request</FieldLabel>
          <Textarea
            id={promptId}
            required
            rows={4}
            maxLength={2000}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={EXAMPLE}
            className="min-h-28 text-lg leading-snug md:text-lg"
          />
          <FieldDescription>What, how much, which store, by when.</FieldDescription>
          <button
            type="button"
            onClick={() => setPrompt(EXAMPLE)}
            className="w-fit py-2 text-muted-foreground text-sm underline underline-offset-4 hover:text-foreground"
          >
            Use the example
          </button>
        </Field>
        <Button
          type="submit"
          size="lg"
          disabled={busy || prompt.trim() === ""}
          className="sm:w-fit"
        >
          {busy ? "Reading your request…" : "Review the mandate"}
        </Button>
        {error ? <ErrorNotice>{error}</ErrorNotice> : null}
      </form>
    );
  }

  const { compiled, signing } = step;
  const gray = compiled.ambiguous.length;
  return (
    <div className="grid gap-8">
      <div className="grid max-w-2xl gap-3">
        <Eyebrow>New mandate · 2 of 2</Eyebrow>
        <h1 className="text-balance font-semibold text-3xl tracking-[-0.03em] sm:text-4xl">
          Check it, then sign
        </h1>
        <p className="text-pretty text-muted-foreground">
          {gray > 0
            ? `${gray} ${gray === 1 ? "field was" : "fields were"} not clear from your request. They stay yours, uncovered. Edit the request to settle them, or sign as is.`
            : "This is your chance to correct it. Once signed, every cart your agent builds is checked against exactly this."}
        </p>
      </div>
      <MandateCard card={signing?.card ?? compiled.card} />
      {compiled.check.status !== "ok" ? (
        <p className="max-w-2xl text-sm text-warn">
          The read-back check could not confirm this card against your request (
          {compiled.check.status}). Read each field before you sign.
        </p>
      ) : null}
      {compiled.check.discrepancies?.map((d) => (
        <p key={d.field} className="max-w-2xl text-sm text-warn">
          {d.field}: {d.issue}
        </p>
      ))}
      <LiabilityLegend />
      <details className="max-w-2xl rounded-lg border px-4 py-3 text-sm">
        <summary className="cursor-pointer py-1 font-medium">
          Signing accepts these terms; their hash is part of what you sign
        </summary>
        <p className="mt-2 whitespace-pre-line text-muted-foreground">{TERMS}</p>
      </details>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button size="lg" disabled={busy || !signing} onClick={() => signing && sign(signing)}>
          {busy ? "Waiting for your passkey…" : signing ? "Sign with passkey" : "Preparing…"}
        </Button>
        <Button
          size="lg"
          variant="outline"
          disabled={busy}
          onClick={() => setStep({ name: "write" })}
        >
          Edit the request
        </Button>
      </div>
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
    </div>
  );
}
