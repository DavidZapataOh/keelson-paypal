"use client";

import { Button } from "@keelson/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@keelson/ui/components/sheet";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { post } from "../lib/api";
import type { Chargeback } from "../lib/types";
import { ErrorNotice } from "./notice";

/** The chargebacks a buyer can file, with the card networks' reason codes for each. */
export const CHARGEBACKS = {
  not_received: { label: "It never arrived", codes: "Visa 13.1 · Mastercard 4853" },
  not_as_described: { label: "Not what the store described", codes: "Visa 13.3 · Mastercard 4853" },
  unauthorized: { label: "I did not authorize this charge", codes: "Visa 10.4 · Mastercard 4837" },
} as const;
type Reason = keyof typeof CHARGEBACKS;

/**
 * A card purchase's dispute: the chargeback goes to the card issuer with the Alibi as evidence.
 * The card network decides; whatever it returns is never paid again from the agent's bond.
 */
export function ChargebackSheet({
  open,
  onOpenChange,
  purchaseId,
  onFiled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  purchaseId: string;
  onFiled: (c: Chargeback) => void;
}) {
  const [reason, setReason] = useState<Reason>("not_as_described");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const file = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onFiled(await post<Chargeback>(`/v1/purchases/${purchaseId}/chargeback`, { reason }));
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The chargeback was not filed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Charge it back</SheetTitle>
          <SheetDescription>
            The card issuer files it with the card network, with this purchase's Alibi as your
            evidence.
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-4 overflow-y-auto px-4 pb-4 text-sm">
          <fieldset className="grid gap-2">
            <legend className="mb-2 font-medium">What happened?</legend>
            {(Object.keys(CHARGEBACKS) as Reason[]).map((r) => (
              <label
                key={r}
                className="grid cursor-pointer gap-0.5 rounded-xl border px-4 py-3 transition-colors hover:bg-foreground/4 has-checked:border-foreground has-focus-visible:outline-2 has-focus-visible:outline-ring"
              >
                <input
                  type="radio"
                  name="chargeback"
                  value={r}
                  checked={reason === r}
                  onChange={() => setReason(r)}
                  className="sr-only"
                />
                <span className="font-medium">{CHARGEBACKS[r].label}</span>
                <span className="font-mono text-muted-foreground text-xs">
                  {CHARGEBACKS[r].codes}
                </span>
              </label>
            ))}
          </fieldset>
          <p className="text-muted-foreground">
            The card network decides. Whatever it returns to you is subtracted from any claim on the
            agent's bond, and the bond pays nothing while the chargeback is open.
          </p>
          {error ? <ErrorNotice>{error}</ErrorNotice> : null}
        </div>
        <SheetFooter className="grid grid-cols-2 gap-3">
          <Button size="lg" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="lg" disabled={busy} onClick={file}>
            {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            File the chargeback
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
