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
  const rows = card.rows.filter((r) => WRONG.includes(r.field));
  const [field, setField] = useState(rows[0]?.field);
  const row = rows.find((r) => r.field === field);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>What was wrong?</SheetTitle>
          <SheetDescription>Pick the part that did not match what you signed.</SheetDescription>
        </SheetHeader>
        <div className="grid gap-5 overflow-y-auto px-4 pb-4">
          <fieldset className="flex flex-wrap gap-1.5">
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
                  checked={field === r.field}
                  onChange={() => setField(r.field)}
                  className="sr-only"
                />
                {r.label}
              </label>
            ))}
          </fieldset>
          {row ? (
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
