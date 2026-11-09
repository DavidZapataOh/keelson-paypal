import { keelsonBondVaultAbi } from "@keelson/chain";
import { ulidToBytes32 } from "@keelson/core";
import { type Db, eq, mandates, purchases } from "@keelson/db";
import type { Hex, PublicClient } from "viem";
import { expect } from "vitest";
import { call, type PayPalDeps } from "../src/paypal.ts";
import { VAULT } from "./pipeline-live.ts";

/** The captures on an order that carry a purchase's invoice id prefix. */
export async function capturesOf(paypal: PayPalDeps, orderId: string, purchaseId?: string) {
  const order = await call(paypal.paypal.orders.getOrder({ id: orderId }));
  return (order.purchaseUnits ?? []).flatMap((u) =>
    (u.payments?.captures ?? []).filter((c) =>
      c.invoiceId?.startsWith(purchaseId ? `KS1-${purchaseId}-` : "KS1-"),
    ),
  );
}

/**
 * What must hold for a purchase once its pipeline has finished, checked against PayPal and the
 * vault rather than the database alone: `CAPTURED` has its leaf, its coverage and exactly one
 * capture of its amount; `FAILED` and `DENIED` have no capture.
 */
export async function checkInvariants(
  deps: { db: Db; paypal: PayPalDeps; chain: PublicClient },
  purchaseId: string,
): Promise<void> {
  const [p] = await deps.db.select().from(purchases).where(eq(purchases.id, purchaseId));
  expect(p, purchaseId).toBeDefined();
  if (!p) return;
  expect(["CAPTURED", "FAILED", "DENIED"], `${purchaseId} ${p.state}`).toContain(p.state);
  const captures = await capturesOf(deps.paypal, p.paypalOrderId as string, purchaseId);
  if (p.state !== "CAPTURED") {
    expect(captures, `${purchaseId} ${p.state} ${p.failureReason}`).toHaveLength(0);
    return;
  }
  expect(p.logIndex).not.toBeNull();
  expect(p.paypalCaptureId).not.toBeNull();
  expect(captures.map((c) => [c.id, c.amount?.value])).toEqual([
    [p.paypalCaptureId, (Number(p.amountMinor) / 100).toFixed(2)],
  ]);
  const coverage = await deps.chain.readContract({
    address: VAULT,
    abi: keelsonBondVaultAbi,
    functionName: "coverages",
    args: [ulidToBytes32(purchaseId) as Hex],
  });
  expect(coverage.status).toBeGreaterThan(0);
  expect(coverage.amount).toBe(p.amountMinor * 10_000n);
}

/** What PayPal captured of a mandate hold is what the mandate's budget lost. */
export async function checkBudget(
  deps: { db: Db; paypal: PayPalDeps },
  mandateId: string,
): Promise<void> {
  const [m] = await deps.db.select().from(mandates).where(eq(mandates.id, mandateId));
  const captures = await capturesOf(deps.paypal, m?.paypalOrderId as string);
  const captured = captures
    .filter((c) => c.status !== "DECLINED" && c.status !== "FAILED")
    .reduce((sum, c) => sum + BigInt(Math.round(Number(c.amount?.value) * 100)), 0n);
  expect(captured).toBe((m?.maxMinor ?? 0n) - (m?.remainingMinor ?? 0n));
}
