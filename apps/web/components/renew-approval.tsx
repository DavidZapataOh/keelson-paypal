import { buttonVariants } from "@keelson/ui/components/button";
import Link from "next/link";
import { money } from "../lib/format";
import type { MandateView } from "../lib/types";

/**
 * An approval issued with the credential issuer key leg A held before the key moved: it no longer
 * countersigns, and signing it again with the same limits replaces it and releases its hold.
 */
export function RenewApproval({ mandate }: { mandate: MandateView }) {
  return (
    <section
      aria-label="Renew approval"
      className="grid gap-3 rounded-2xl border border-border bg-card px-4 py-4"
    >
      <div className="grid gap-1">
        <p className="font-semibold">Renew approval</p>
        <p className="text-muted-foreground text-sm">
          Keelson moved its TEE keys under on-chain governance; approvals from before must be signed
          again.
        </p>
      </div>
      <p className="text-sm">
        Same limits: up to {money(BigInt(mandate.budget.maxMinor), mandate.budget.currency)}. The
        old hold is released.
      </p>
      <Link href={`/new/?renew=${mandate.id}`} className={buttonVariants({ className: "w-fit" })}>
        Renew approval
      </Link>
    </section>
  );
}
