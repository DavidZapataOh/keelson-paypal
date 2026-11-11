"use client";

import type { Card } from "@keelson/mandate/browser";
import { Button } from "@keelson/ui/components/button";
import { CopyValue } from "@keelson/ui/components/copy-value";
import { LiabilityMark } from "@keelson/ui/components/liability";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@keelson/ui/components/sheet";
import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { PAYPAL_RESOLUTION } from "../lib/config";
import { DISPUTE_KINDS, type DisputeKind } from "../lib/dispute-kinds";

/** The parts of an order a buyer can say were wrong, in the card's field ids. */
const WRONG = ["items", "variant", "quantity", "total", "merchant", "category", "return_policy"];
const KIND = { green: "verified", amber: "attested", gray: "yours" } as const;
const WHO = {
  green: "Keelson answers for this, from its reserve.",
  amber: "The agent's operator answers for this, from its bond.",
  gray: "This was left to the agent's judgment, so it is yours.",
} as const;

/**
 * What a buyer sees before disputing: which part was wrong, what they signed for it, who answers,
 * and where to open the dispute. PayPal decides; Keelson reads the dispute when PayPal sends it
 * and brings this Alibi as evidence.
 */
export function DisputeSheet({
  open,
  onOpenChange,
  card,
  alibiId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  card: Card;
  alibiId: string;
}) {
  const [kind, setKind] = useState<DisputeKind>("error");
  // An agent error is a detail the operator vouched for; "not what I meant" is about taste.
  const rows = card.rows.filter(
    (r) =>
      WRONG.includes(r.field) &&
      (kind === "error" ? r.color === "amber" : kind === "intent" ? r.color !== "green" : true),
  );
  const [field, setField] = useState<string>();
  const row = rows.find((r) => r.field === field) ?? rows[0];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>What happened?</SheetTitle>
          <SheetDescription>Pick the closest. It decides who answers.</SheetDescription>
        </SheetHeader>
        <div className="grid gap-5 overflow-y-auto px-4 pb-4">
          <fieldset className="grid gap-1.5">
            <legend className="sr-only">What happened</legend>
            {(Object.keys(DISPUTE_KINDS) as DisputeKind[]).map((k) => (
              <label
                key={k}
                className="grid cursor-pointer gap-0.5 rounded-2xl border px-4 py-3 has-checked:border-foreground has-checked:bg-foreground/4 has-focus-visible:outline-2 has-focus-visible:outline-ring"
              >
                <input
                  type="radio"
                  name="kind"
                  value={k}
                  checked={kind === k}
                  onChange={() => {
                    setKind(k);
                    setField(undefined);
                  }}
                  className="sr-only"
                />
                <span className="font-medium text-sm">{DISPUTE_KINDS[k].label}</span>
                <span className="text-muted-foreground text-xs">{DISPUTE_KINDS[k].detail}</span>
              </label>
            ))}
          </fieldset>
          {kind === "rogue" ? (
            <p className="flex items-start gap-2.5 rounded-2xl bg-bone-2/70 p-4 text-sm">
              <LiabilityMark kind="verified" className="mt-0.5" />
              Keelson blocks carts outside your mandate before payment. If one got through, Keelson
              answers from its reserve.
            </p>
          ) : null}
          {kind === "unrecognized" ? (
            <p className="rounded-2xl bg-bone-2/70 p-4 text-sm">
              The Alibi below shows the mandate you signed and the check this cart passed.
            </p>
          ) : null}
          <fieldset
            className={`flex flex-wrap gap-1.5 ${kind === "intent" || kind === "error" ? "" : "hidden"}`}
          >
            <legend className="sr-only">The part that was wrong</legend>
            {rows.map((r) => (
              <label
                key={r.field}
                className="h-9 cursor-pointer content-center rounded-full border px-3.5 text-sm has-checked:border-foreground has-checked:bg-foreground has-checked:text-background has-focus-visible:outline-2 has-focus-visible:outline-ring"
              >
                <input
                  type="radio"
                  name="wrong"
                  value={r.field}
                  checked={row?.field === r.field}
                  onChange={() => setField(r.field)}
                  className="sr-only"
                />
                {r.label}
              </label>
            ))}
          </fieldset>
          {row && (kind === "intent" || kind === "error") ? (
            <div className="grid gap-3 rounded-2xl bg-bone-2/70 p-4">
              <p className="text-muted-foreground text-sm">You signed</p>
              <p className="font-medium">{row.values.join(", ")}</p>
              <p className="flex items-start gap-2.5 text-sm">
                <LiabilityMark kind={KIND[row.color]} className="mt-0.5" />
                {WHO[row.color]}
              </p>
            </div>
          ) : null}
          <div className="grid gap-2">
            <p className="text-sm">Open the dispute on PayPal and paste your Alibi id:</p>
            <CopyValue value={alibiId} label="Alibi id" />
            <p className="text-muted-foreground text-xs">
              Keelson reads the dispute as soon as PayPal sends it. PayPal still decides disputes.
            </p>
          </div>
        </div>
        <SheetFooter className="grid grid-cols-2 gap-3">
          <Button size="lg" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="lg" asChild>
            <a href={PAYPAL_RESOLUTION} target="_blank" rel="noopener">
              Open on PayPal
              <ArrowUpRight aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
