"use client";

import type { Signing } from "@keelson/mandate/browser";
import { TERMS } from "@keelson/mandate/browser";
import { Button } from "@keelson/ui/components/button";
import { Liability } from "@keelson/ui/components/liability";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@keelson/ui/components/sheet";
import { money } from "../lib/format";
import type { Compiled } from "../lib/types";

const fieldValue = (signing: Signing, field: string) =>
  signing.card.rows.find((r) => r.field === field)?.values.join(", ");

/**
 * The grant, said once before the passkey: who may buy, where, up to what and until when; what
 * Keelson and the operator answer for; and last, what nobody covers. Cancel weighs as much as
 * signing, and the signing button names the act and the cap.
 */
export function SignSheet({
  open,
  onOpenChange,
  signing,
  compiled,
  busy,
  onSign,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  signing: Signing;
  compiled: Compiled;
  busy: boolean;
  onSign: () => void;
}) {
  const budget = compiled.mandateDraft.payment.constraints.find((c) => c.type === "payment.budget");
  const cap = budget ? money(BigInt(budget.max), compiled.mandateDraft.payment.currency) : "";
  const rows = signing.card.rows;
  const count = (color: string) => rows.filter((r) => r.color === color).length;
  const yours = rows.filter((r) => r.color === "gray").map((r) => r.label);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Sign this mandate</SheetTitle>
          <SheetDescription>
            Your agent may buy at {fieldValue(signing, "merchant") ?? "the stores shown"}, up to{" "}
            {cap}, until {fieldValue(signing, "deadline") ?? "the date shown"}.
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-5 overflow-y-auto px-4 pb-4 text-sm">
          <ul className="grid gap-3">
            <li className="grid gap-1">
              <Liability kind="verified" />
              <span className="text-muted-foreground">
                {count("green")} fields Keelson checks before every payment and answers for.
              </span>
            </li>
            <li className="grid gap-1">
              <Liability kind="attested" />
              <span className="text-muted-foreground">
                {count("amber")} fields the agent's operator answers for from its bond.
              </span>
            </li>
            <li className="grid gap-1">
              <Liability kind="yours" />
              <span className="text-muted-foreground">
                {yours.length > 0
                  ? `Nobody covers: ${yours.join(", ")}. If the agent gets these wrong, it is on you.`
                  : "Nothing is left uncovered."}
              </span>
            </li>
          </ul>
          <details className="rounded-md border px-3 py-2">
            <summary className="cursor-pointer py-1 font-medium">
              The terms you accept by signing
            </summary>
            <p className="mt-2 whitespace-pre-line text-muted-foreground">{TERMS}</p>
          </details>
        </div>
        <SheetFooter className="grid grid-cols-2 gap-3">
          <Button size="lg" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="lg" disabled={busy} onClick={onSign}>
            {busy ? "Waiting for your passkey…" : `Sign: allow up to ${cap}`}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
