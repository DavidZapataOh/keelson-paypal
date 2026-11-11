import {
  CARD_BITS,
  type CardAuthorization,
  cardAuthorizationDigest,
  keelsonDomain,
} from "@keelson/core/eip712";
import {
  and,
  cardAuthorizations,
  type Db,
  eq,
  mandates,
  purchaseCards,
  purchases,
  type StoredCardVerdict,
} from "@keelson/db";
import type { Logger } from "pino";
import { type Address, getAddress, type Hex, keccak256, recoverAddress, toHex } from "viem";
import { countersignOf } from "../pipeline/leaf.ts";
import type { CardAuthorized, CardNetworkAuthorization } from "../tee/client.ts";
import { VERIFYING_CONTRACT } from "../tee/config.ts";
import type { TeeConfig } from "../tee/signers.ts";

/** How long each leg may take: both answer in parallel, inside the issuer's few seconds. */
export const LEG_DEADLINE_MS = 1_500;
/**
 * How long after the issuer's request a decision may still approve: past it the issuer has been
 * told to decline, so a late approval is stored as the decline the network saw.
 */
export const DECIDE_DEADLINE_MS = 2_200;

/** The issuer's answer: `APPROVED`, or the reason a merchant is told. */
export type CardResult =
  | "APPROVED"
  | "UNAUTHORIZED_MERCHANT"
  | "INSUFFICIENT_FUNDS"
  | "VELOCITY_EXCEEDED"
  | "CARD_PAUSED"
  | "SUSPECTED_FRAUD";

export interface CardVetoDeps {
  db: Db;
  log: Logger;
  tee?: Pick<TeeConfig, "client"> | undefined;
}

/** A card network authorization of one card, as the issuer's real-time request reported it. */
export interface NetworkAuthorization extends CardNetworkAuthorization {
  cardToken: string;
  /** The issuer's transaction the request belongs to; `id` is the request's own. */
  transactionToken: string;
}

export interface CardDecision {
  approved: boolean;
  result: CardResult;
  failedMask: number;
}

const bit = (name: keyof typeof CARD_BITS) => 1 << CARD_BITS[name];

/** What a merchant is told about a declined authorization, from the reasons the legs gave. */
export function resultOf(failedMask: number, reason: string | null): CardResult {
  if (failedMask === 0 && reason === null) return "APPROVED";
  if (reason === "timeout") return "SUSPECTED_FRAUD";
  if (failedMask & (bit("mcc") | bit("country") | bit("merchant"))) return "UNAUTHORIZED_MERCHANT";
  if (failedMask & bit("amount")) return "INSUFFICIENT_FUNDS";
  if (failedMask & bit("used")) return "VELOCITY_EXCEEDED";
  if (failedMask & bit("expired") || reason === "card-not-open") return "CARD_PAUSED";
  return "SUSPECTED_FRAUD";
}

/** The typed-data message of a leg's answer, with its integers as bigints. */
function messageOf(a: CardAuthorized["authorization"]): CardAuthorization {
  return {
    requestId: a.requestId,
    countersignDigest: a.countersignDigest,
    authorizationHash: a.authorizationHash,
    merchantHash: a.merchantHash,
    mcc: Number(a.mcc),
    country: a.country,
    amount: BigInt(a.amount),
    currency: Number(a.currency),
    decision: Number(a.decision),
    failedMask: Number(a.failedMask),
    issuedAt: Number(a.issuedAt),
  };
}

/**
 * Whether `out` is the leg's signed approval of this authorization under this countersign: its
 * digest is the message's and its signature recovers to the signer of the leg's countersign.
 */
async function approves(
  out: CardAuthorized,
  signer: Address,
  requestId: Hex,
  countersignDigest: Hex,
  n: CardNetworkAuthorization,
): Promise<boolean> {
  const a = out.authorization;
  if (a.requestId !== requestId || a.countersignDigest !== countersignDigest) return false;
  // The answer is for this request: its id, amount, merchant code and country.
  if (
    a.authorizationHash !== keccak256(toHex(n.id)) ||
    a.amount !== String(n.amount_minor) ||
    a.mcc !== String(Number(n.mcc)) ||
    a.country !== toHex(n.merchant_country)
  ) {
    return false;
  }
  const digest = cardAuthorizationDigest(messageOf(a), keelsonDomain(421614, VERIFYING_CONTRACT));
  if (digest !== out.digest) return false;
  const recovered = await recoverAddress({ hash: digest, signature: out.signature });
  return getAddress(recovered) === signer && a.decision === "1" && a.failedMask === "0";
}

/**
 * Decides one card network authorization: approved only when both legs approve it, each over
 * its own ALLOW of the purchase the card was issued for. Anything else declines it: an unknown
 * card, a card not open or past its countersign, a leg that does not answer in time, an answer
 * that does not verify. The decision is stored under the issuer's authorization id, so the
 * issuer's retries get the same answer.
 */
export async function decide(
  deps: CardVetoDeps,
  n: NetworkAuthorization,
  receivedAt: number,
  deadline = receivedAt + DECIDE_DEADLINE_MS,
): Promise<CardDecision> {
  const { db } = deps;
  const [seen] = await db.select().from(cardAuthorizations).where(eq(cardAuthorizations.id, n.id));
  if (seen) {
    return {
      approved: seen.approved,
      result: resultOf(seen.failedMask, seen.reason),
      failedMask: seen.failedMask,
    };
  }
  const [row] = await db
    .select({ card: purchaseCards, purchase: purchases, mandate: mandates })
    .from(purchaseCards)
    .innerJoin(purchases, eq(purchases.id, purchaseCards.purchaseId))
    .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
    .where(eq(purchaseCards.cardToken, n.cardToken));
  // A card Keelson did not issue has nothing to be checked against, and no purchase to file under.
  if (!row) return { approved: false, result: "SUSPECTED_FRAUD", failedMask: 0 };

  let reason: string | null = null;
  let failedMask = 0;
  const verdicts: { tdx: StoredCardVerdict | null; nitro: StoredCardVerdict | null } = {
    tdx: null,
    nitro: null,
  };
  const approvedBefore = async () =>
    (
      await db
        .select({ id: cardAuthorizations.id })
        .from(cardAuthorizations)
        .where(
          and(
            eq(cardAuthorizations.purchaseId, row.purchase.id),
            eq(cardAuthorizations.approved, true),
          ),
        )
        .limit(1)
    ).length > 0;
  if (row.card.state === "USED" || row.card.state === "CLOSED" || (await approvedBefore())) {
    failedMask |= bit("used");
  } else if (row.card.state !== "OPEN" || row.purchase.state !== "COVERED") {
    reason = "card-not-open";
  } else if (row.card.expiresAt.getTime() <= Date.now()) reason = "card-expired";
  else if (row.purchase.countersignMode !== "2of2") reason = "not-2of2";
  else if (!deps.tee) reason = "tee-unavailable";
  else if (!row.mandate.payloadSd || !row.mandate.disclosures) reason = "mandate-unreadable";
  if (reason === null && failedMask === 0 && deps.tee) {
    const stored = await countersignOf(db, row.purchase.id);
    const nitro = stored.signers.nitro;
    const request = (signature: Hex) => ({
      countersign: stored.countersign,
      signature,
      payload_sd: row.mandate.payloadSd,
      disclosures: row.mandate.disclosures as string[],
      authorization: {
        id: n.id,
        amount_minor: n.amount_minor,
        currency: n.currency,
        mcc: n.mcc,
        merchant_name: n.merchant_name,
        merchant_country: n.merchant_country,
        network_id: n.network_id,
      },
    });
    const [a, b] = await Promise.allSettled([
      deps.tee.client.a.cardAuthorize(request(stored.signatures.tdx), LEG_DEADLINE_MS),
      stored.signatures.nitro && nitro
        ? deps.tee.client.b.cardAuthorize(request(stored.signatures.nitro), LEG_DEADLINE_MS)
        : Promise.reject(new Error("no leg B countersign")),
    ]);
    if (a.status === "fulfilled") {
      verdicts.tdx = a.value;
      failedMask |= Number(a.value.authorization.failedMask);
    }
    if (b.status === "fulfilled") {
      verdicts.nitro = b.value;
      failedMask |= Number(b.value.authorization.failedMask);
    }
    const both =
      a.status === "fulfilled" &&
      b.status === "fulfilled" &&
      nitro !== null &&
      (await approves(
        a.value,
        stored.signers.tdx,
        stored.countersign.requestId,
        stored.digest,
        n,
      )) &&
      (await approves(b.value, nitro, stored.countersign.requestId, stored.digest, n));
    if (!both && failedMask === 0) {
      reason =
        a.status === "rejected" || b.status === "rejected" ? "leg-unavailable" : "unverified";
      for (const r of [a, b]) {
        if (r.status === "rejected")
          deps.log.warn({ err: r.reason, auth: n.id }, "card leg failed");
      }
    }
  }
  if (reason === null && failedMask === 0 && performance.now() > deadline) reason = "timeout";
  const approved = reason === null && failedMask === 0;
  const insert = (approve: boolean, mask: number) =>
    db
      .insert(cardAuthorizations)
      .values({
        id: n.id,
        transactionToken: n.transactionToken,
        purchaseId: row.purchase.id,
        amountMinor: BigInt(n.amount_minor),
        currency: n.currency,
        mcc: /^[0-9]{4}$/.test(n.mcc) ? n.mcc : "0000",
        merchantName: n.merchant_name,
        merchantCountry: n.merchant_country,
        networkId: n.network_id,
        approved: approve,
        failedMask: mask,
        reason,
        tdx: verdicts.tdx,
        nitro: verdicts.nitro,
        latencyMs: Math.round(performance.now() - receivedAt),
      })
      .onConflictDoNothing({ target: cardAuthorizations.id })
      .returning({ id: cardAuthorizations.id });
  let inserted: { id: string }[];
  try {
    inserted = await insert(approved, failedMask);
  } catch (err) {
    // Another authorization of the card was approved meanwhile: this one is a second use.
    const e = err as { code?: string; cause?: { code?: string } };
    if ((e.cause?.code ?? e.code) !== "23505") throw err;
    return decideUsed();
  }
  if (inserted.length === 0) return decide(deps, n, receivedAt, deadline);
  async function decideUsed(): Promise<CardDecision> {
    const mask = failedMask | bit("used");
    const again = await insert(false, mask);
    if (again.length === 0) return decide(deps, n, receivedAt, deadline);
    return { approved: false, result: resultOf(mask, reason), failedMask: mask };
  }
  if (approved) {
    await db
      .update(purchaseCards)
      .set({ state: "USED" })
      .where(and(eq(purchaseCards.purchaseId, row.purchase.id), eq(purchaseCards.state, "OPEN")));
  }
  return { approved, result: resultOf(failedMask, reason), failedMask };
}
