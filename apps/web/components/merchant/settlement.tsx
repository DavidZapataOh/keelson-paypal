"use client";

import { Alert, AlertDescription } from "@keelson/ui/components/alert";
import { Button } from "@keelson/ui/components/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@keelson/ui/components/field";
import { Input } from "@keelson/ui/components/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@keelson/ui/components/sheet";
import { useState } from "react";
import {
  CHAIN_ID,
  chooseSettlement,
  injectedWallet,
  type MerchantSelf,
  type Rail,
  type Settlement,
} from "../../lib/merchant";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** One sentence: what a won dispute pays, where. */
export function consequence(
  merchant: MerchantSelf,
  s: Pick<Settlement, "rail" | "paypal_receiver">,
) {
  return s.rail === "paypal"
    ? `Disputes decided in your favour pay a PayPal Payout in USD to ${s.paypal_receiver}.`
    : `Disputes decided in your favour pay PYUSD on chain to ${short(merchant.settlement_address)}.`;
}

const RAILS: { rail: Rail; title: string; detail: string }[] = [
  {
    rail: "pyusd",
    title: "PYUSD on chain",
    detail: "Settles to your settlement address on Arbitrum once the verdict executes.",
  },
  {
    rail: "paypal",
    title: "PayPal Payout",
    detail: "Keelson's treasury receives the PYUSD and sends USD to your PayPal account.",
  },
];

/**
 * The merchant's settlement choice: the current one first, then the two rails with their
 * consequence, then the EIP-712 fields the wallet signs. The API stores nothing without the
 * settlement wallet's signature.
 */
export function SettlementSheet({
  open,
  onOpenChange,
  merchant,
  current,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  merchant: MerchantSelf;
  current: Settlement;
  onSaved: (s: Settlement) => void;
}) {
  const [rail, setRail] = useState<Rail>(current.rail);
  const [receiver, setReceiver] = useState(current.paypal_receiver ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const invalid = rail === "paypal" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$|^[A-Z0-9]{13}$/.test(receiver);

  async function sign(e: React.FormEvent) {
    e.preventDefault();
    if (invalid) return;
    const wallet = injectedWallet();
    if (!wallet) {
      setError("No browser wallet holds your settlement key here. Nothing changed.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      onSaved(
        await chooseSettlement(wallet, merchant, current, { rail, paypalReceiver: receiver }),
      );
      onOpenChange(false);
    } catch (err) {
      const code = (err as { code?: number }).code;
      setError(
        code === 4001
          ? "You rejected the signature. Nothing changed."
          : `${(err as Error).message} Nothing changed.`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <form onSubmit={sign} className="grid gap-6">
          <SheetHeader>
            <SheetTitle>Sign to change how you are paid</SheetTitle>
            <SheetDescription>
              Applies to verdicts signed after this. Verdicts already signed keep the rail they
              name.
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-6 px-4">
            <fieldset className="grid gap-3">
              <legend className="mb-2 font-medium text-sm">Rail</legend>
              {RAILS.map((r) => (
                <label
                  key={r.rail}
                  className="grid cursor-pointer grid-cols-[auto_1fr] gap-x-3 rounded-[10px] border p-4 has-checked:border-foreground"
                >
                  <input
                    type="radio"
                    name="rail"
                    value={r.rail}
                    checked={rail === r.rail}
                    onChange={() => setRail(r.rail)}
                    className="mt-1 accent-foreground"
                  />
                  <span className="font-medium">{r.title}</span>
                  <span className="col-start-2 text-muted-foreground text-sm">{r.detail}</span>
                </label>
              ))}
            </fieldset>
            {rail === "paypal" ? (
              <Field data-invalid={invalid && receiver !== "" ? true : undefined}>
                <FieldLabel htmlFor="receiver">PayPal account</FieldLabel>
                <Input
                  id="receiver"
                  type="text"
                  inputMode="email"
                  autoComplete="email"
                  value={receiver}
                  aria-invalid={invalid && receiver !== ""}
                  onChange={(e) => setReceiver(e.target.value.trim())}
                  placeholder="payouts@yourstore.com"
                />
                <FieldDescription>
                  An email address or a 13-character PayPal account id.
                </FieldDescription>
                {invalid && receiver !== "" ? (
                  <FieldError>Enter an email such as payouts@yourstore.com.</FieldError>
                ) : null}
              </Field>
            ) : null}
            <p className="text-pretty">
              {consequence(merchant, { rail, paypal_receiver: receiver })}
            </p>
            <div className="grid gap-2">
              <p className="font-medium text-sm">Your wallet signs</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-[10px] border bg-muted p-3 font-mono text-xs">
                <dt className="text-muted-foreground">type</dt>
                <dd>SettlementPreference</dd>
                <dt className="text-muted-foreground">merchantId</dt>
                <dd>{merchant.merchant_id}</dd>
                <dt className="text-muted-foreground">rail</dt>
                <dd>{rail}</dd>
                <dt className="text-muted-foreground">paypalReceiver</dt>
                <dd className="break-all">{rail === "paypal" ? receiver || "—" : "(empty)"}</dd>
                <dt className="text-muted-foreground">nonce</dt>
                <dd>{(BigInt(current.nonce) + 1n).toString()}</dd>
                <dt className="text-muted-foreground">domain</dt>
                <dd>Keelson v1, chain {CHAIN_ID}</dd>
                <dt className="text-muted-foreground">signer</dt>
                <dd className="break-all">{merchant.settlement_address}</dd>
              </dl>
            </div>
            {error ? (
              <Alert variant="destructive" role="status">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>
          <SheetFooter>
            <Button type="submit" disabled={busy || invalid}>
              {busy ? "Waiting for your wallet…" : "Sign in wallet"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
