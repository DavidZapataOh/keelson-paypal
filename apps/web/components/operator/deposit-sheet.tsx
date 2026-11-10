"use client";

import { Amount } from "@keelson/ui/components/amount";
import { Button } from "@keelson/ui/components/button";
import { DataItem, DataList } from "@keelson/ui/components/data-list";
import { Field, FieldDescription, FieldError, FieldLabel } from "@keelson/ui/components/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@keelson/ui/components/input-group";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@keelson/ui/components/sheet";
import { Timeline, TimelineItem } from "@keelson/ui/components/timeline";
import { useEffect, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { ApiError } from "../../lib/api";
import {
  CHAIN_ID,
  depositWithPermit,
  injectedWallet,
  permitFor,
  pyusdOf,
  type RelayedTx,
  settled,
} from "../../lib/operator";

type Step =
  | { kind: "amount" }
  | { kind: "review"; typed: ReturnType<typeof permitFor> }
  | { kind: "sending"; typed: ReturnType<typeof permitFor>; tx?: RelayedTx }
  | { kind: "done"; typed: ReturnType<typeof permitFor>; tx: RelayedTx };

const AMOUNT = /^\d{1,9}(\.\d{1,6})?$/;

/**
 * The gasless deposit: the amount and the new free bond, then the exact EIP-2612 permit the wallet
 * signs, then the relayed transaction as a receipt.
 */
export function DepositSheet({
  open,
  onOpenChange,
  agentId,
  owner,
  free,
  onDeposited,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  owner: `0x${string}`;
  free: number;
  onDeposited: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "amount" });
  const [amount, setAmount] = useState("");
  const [balance, setBalance] = useState<bigint>();
  const [nonce, setNonce] = useState<bigint>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setStep({ kind: "amount" });
    setError(undefined);
    const wallet = injectedWallet();
    if (!wallet) {
      setError("No browser wallet found.");
      return;
    }
    pyusdOf(wallet, owner)
      .then((r) => {
        setBalance(r.balance);
        setNonce(r.nonce);
      })
      .catch((err: Error) => setError(err.message));
  }, [open, owner]);

  const value = AMOUNT.test(amount) ? parseUnits(amount, 6) : 0n;
  const invalid =
    amount === ""
      ? undefined
      : !AMOUNT.test(amount) || value === 0n
        ? "Enter an amount in PYUSD, e.g. 1.50."
        : balance !== undefined && value > balance
          ? `Your wallet holds ${formatUnits(balance, 6)} PYUSD.`
          : undefined;

  async function sign(typed: ReturnType<typeof permitFor>) {
    const wallet = injectedWallet();
    if (!wallet) return;
    setError(undefined);
    setStep({ kind: "sending", typed });
    try {
      const sent = await depositWithPermit(wallet, agentId, typed);
      setStep({ kind: "sending", typed, tx: sent });
      const tx = await settled(sent);
      setStep({ kind: "done", typed, tx });
      onDeposited();
    } catch (err) {
      setStep({ kind: "review", typed });
      setError(
        (err as { code?: number }).code === 4001
          ? "You rejected the signature. Nothing was sent."
          : err instanceof ApiError
            ? `Keelson did not send it: ${err.message}`
            : (err as Error).message,
      );
    }
  }

  const typed = step.kind === "amount" ? undefined : step.typed;
  const tx = step.kind === "sending" || step.kind === "done" ? step.tx : undefined;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Deposit PYUSD into the bond</SheetTitle>
          <SheetDescription>
            You sign a PYUSD permit in your wallet; Keelson sends the deposit and pays its gas.
          </SheetDescription>
        </SheetHeader>

        <div className="grid gap-5 px-4">
          {step.kind === "amount" ? (
            <Field data-invalid={invalid ? true : undefined}>
              <FieldLabel htmlFor="deposit-amount">Amount</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="deposit-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.trim())}
                  aria-invalid={invalid ? true : undefined}
                  className="font-mono"
                />
                <InputGroupAddon align="inline-end">PYUSD</InputGroupAddon>
              </InputGroup>
              {invalid ? (
                <FieldError>{invalid}</FieldError>
              ) : (
                <FieldDescription>
                  {balance === undefined
                    ? "Reading your wallet's PYUSD…"
                    : `In your wallet: ${formatUnits(balance, 6)} PYUSD. Free bond after: ${(free + Number(formatUnits(value, 6))).toFixed(2)} PYUSD.`}
                </FieldDescription>
              )}
            </Field>
          ) : null}

          {typed ? (
            <section aria-labelledby="permit" className="grid gap-2">
              <h3 id="permit" className="font-medium text-sm">
                Your wallet signs (EIP-2612 permit)
              </h3>
              <DataList
                className="rounded-[10px] border px-3 font-mono text-xs"
                data-testid="permit"
              >
                <DataItem label="Token">PayPal USD · {typed.domain?.verifyingContract}</DataItem>
                <DataItem label="Spender">KeelsonBondVault · {typed.message.spender}</DataItem>
                <DataItem label="Owner">{typed.message.owner}</DataItem>
                <DataItem label="Value">
                  <span>
                    {typed.message.value.toString()} ({formatUnits(typed.message.value, 6)} PYUSD)
                  </span>
                </DataItem>
                <DataItem label="Nonce">{typed.message.nonce.toString()}</DataItem>
                <DataItem label="Deadline">
                  {new Date(Number(typed.message.deadline) * 1000).toISOString()}
                </DataItem>
                <DataItem label="Chain">{CHAIN_ID} · Arbitrum Sepolia</DataItem>
                <DataItem label="Gas">None for you: Keelson sends it</DataItem>
              </DataList>
            </section>
          ) : null}

          {step.kind === "sending" || step.kind === "done" ? (
            <Timeline aria-label="Deposit">
              <TimelineItem state="done" actor="You">
                Signed the permit for {formatUnits(step.typed.message.value, 6)} PYUSD
              </TimelineItem>
              <TimelineItem
                state={
                  step.kind === "done"
                    ? tx?.status === "confirmed"
                      ? "done"
                      : "failed"
                    : "current"
                }
                actor="Keelson"
                {...(tx?.explorerUrl ? { proof: { href: tx.explorerUrl, label: "Arbiscan" } } : {})}
              >
                {step.kind === "done"
                  ? tx?.status === "confirmed"
                    ? `Sent depositWithPermit, confirmed in block ${tx.blockNumber ?? ""}`
                    : `depositWithPermit ended ${tx?.status}`
                  : "Sending depositWithPermit…"}
              </TimelineItem>
            </Timeline>
          ) : null}

          {step.kind === "done" && tx?.status === "confirmed" ? (
            <p className="text-sm" data-testid="deposit-receipt">
              <Amount value={Number(formatUnits(step.typed.message.value, 6))} hideCurrency /> PYUSD
              added to the free bond.{" "}
              {tx.hash ? (
                <span className="break-all font-mono text-muted-foreground text-xs">{tx.hash}</span>
              ) : null}
            </p>
          ) : null}

          <p role="status" className="min-h-5 text-destructive text-sm">
            {error}
          </p>
        </div>

        <SheetFooter>
          {step.kind === "amount" ? (
            <Button
              disabled={!!invalid || value === 0n || nonce === undefined}
              onClick={() =>
                nonce !== undefined &&
                setStep({ kind: "review", typed: permitFor(owner, value, nonce) })
              }
            >
              Review the permit
            </Button>
          ) : step.kind === "review" ? (
            <>
              <Button onClick={() => void sign(step.typed)}>
                Sign permit · deposit {formatUnits(step.typed.message.value, 6)} PYUSD
              </Button>
              <Button variant="outline" onClick={() => setStep({ kind: "amount" })}>
                Back
              </Button>
            </>
          ) : step.kind === "done" ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          ) : (
            <Button disabled>Waiting…</Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
