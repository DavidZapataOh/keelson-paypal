import {
  and,
  type Db,
  eq,
  inArray,
  lt,
  mandates,
  purchaseCards,
  purchases,
  sql,
} from "@keelson/db";
import { decodeMandate, type Mandate } from "@keelson/mandate";
import type { Logger } from "pino";
import type { CardIssuer } from "../cards/issuer.ts";
import type { CountersignJson } from "../tee/client.ts";
import { done, final, type Outcome, retry } from "./outcome.ts";

export interface CardStepDeps {
  db: Db;
  log: Logger;
  cardIssuer?: CardIssuer | undefined;
}

/** The merchant category codes and countries a card mandate allows for the cart's merchant. */
export function cardControlsOf(
  m: Mandate,
  merchantId: string,
): { mcc: string[]; countries: string[] } | undefined {
  const allowed = m.checkout.constraints.find((c) => c.type === "checkout.allowed_merchants");
  if (allowed?.type !== "checkout.allowed_merchants") return undefined;
  // The countersign names the merchant as the mandate does: `*` for any store.
  const x = allowed.allowed.find((x) => x.id === merchantId);
  if (!x?.mcc || !x.country) return undefined;
  return { mcc: [...x.mcc], countries: [x.country] };
}

/**
 * Issues the single-use card of a card purchase, paused, once its 2-of-2 ALLOW is stored: capped
 * at the countersigned amount, at the merchant category codes and country the mandate allows for
 * the cart's merchant, and usable until the countersign expires. The card is issued before the
 * purchase is logged, so its leaf commits to the card. A card issued twice by concurrent drivers
 * is closed again.
 */
export async function issueCardStep(
  deps: CardStepDeps,
  purchaseId: string,
): Promise<Outcome<{ token: string }>> {
  const { db } = deps;
  const [existing] = await db
    .select({ token: purchaseCards.cardToken })
    .from(purchaseCards)
    .where(eq(purchaseCards.purchaseId, purchaseId));
  if (existing) return done(existing);
  if (!deps.cardIssuer) return final("card:not-configured");
  const [row] = await db
    .select({ purchase: purchases, mandate: mandates })
    .from(purchases)
    .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
    .where(eq(purchases.id, purchaseId));
  if (!row) return final("card:no-purchase");
  const { purchase, mandate } = row;
  // A card answers to both legs at every authorization: one leg alone issues none.
  if (purchase.countersignMode !== "2of2") return final("card:not-2of2");
  const cs = purchase.countersign as unknown as CountersignJson | null;
  const expiresAt = new Date(Number(cs?.expiresAt) * 1000);
  if (!cs || !(expiresAt.getTime() > Date.now())) return final("card:expired");
  if (!mandate.payloadSd || !mandate.disclosures) return final("card:mandate-unreadable");
  const controls = cardControlsOf(
    decodeMandate(mandate.payloadSd as Record<string, unknown>, mandate.disclosures),
    purchase.merchantId,
  );
  if (!controls) return final("card:merchant-not-allowed");
  let issued: Awaited<ReturnType<CardIssuer["issue"]>>;
  try {
    issued = await deps.cardIssuer.issue({
      spendLimitMinor: purchase.amountMinor,
      mcc: controls.mcc,
      countries: controls.countries,
      memo: `Keelson ${purchaseId}`,
    });
  } catch (err) {
    deps.log.warn({ err, purchaseId }, "card not issued");
    return retry("card:issuer-unavailable");
  }
  const stored = await db
    .insert(purchaseCards)
    .values({
      purchaseId,
      issuer: deps.cardIssuer.name,
      cardToken: issued.token,
      lastFour: issued.lastFour,
      controls: {
        spend_limit_minor: purchase.amountMinor.toString(),
        currency: purchase.currency,
        mcc: controls.mcc,
        countries: controls.countries,
        single_use: true,
      },
      state: "PAUSED",
      expiresAt,
    })
    .onConflictDoNothing({ target: purchaseCards.purchaseId })
    .returning({ token: purchaseCards.cardToken });
  if (stored[0]) return done(stored[0]);
  await deps.cardIssuer.close(issued.token).catch((err: unknown) => {
    deps.log.error({ err, purchaseId }, "duplicate card not closed");
  });
  const [winner] = await db
    .select({ token: purchaseCards.cardToken })
    .from(purchaseCards)
    .where(eq(purchaseCards.purchaseId, purchaseId));
  return winner ? done(winner) : retry("card:conflict");
}

/** Opens the purchase's card once the purchase is logged and covered, as a capture would run. */
export async function openCardStep(
  deps: CardStepDeps,
  purchaseId: string,
): Promise<Outcome<{ token: string }>> {
  const { db } = deps;
  const [card] = await db
    .select()
    .from(purchaseCards)
    .where(eq(purchaseCards.purchaseId, purchaseId));
  if (!card) return final("card:not-issued");
  if (card.state !== "PAUSED") return done({ token: card.cardToken });
  if (!deps.cardIssuer) return final("card:not-configured");
  if (card.expiresAt.getTime() <= Date.now()) return final("card:expired");
  try {
    await deps.cardIssuer.open(card.cardToken);
  } catch (err) {
    deps.log.warn({ err, purchaseId }, "card not opened");
    return retry("card:issuer-unavailable");
  }
  await db
    .update(purchaseCards)
    .set({ state: "OPEN" })
    .where(and(eq(purchaseCards.purchaseId, purchaseId), eq(purchaseCards.state, "PAUSED")));
  return done({ token: card.cardToken });
}

/**
 * Closes the cards that were never used before their countersign expired and fails their
 * purchases, so nothing can be authorized on them later. Returns how many it closed.
 */
export async function closeExpiredCards(deps: CardStepDeps): Promise<number> {
  const { db } = deps;
  const expired = await db
    .select({ purchaseId: purchaseCards.purchaseId, token: purchaseCards.cardToken })
    .from(purchaseCards)
    .where(
      and(
        inArray(purchaseCards.state, ["PAUSED", "OPEN"]),
        lt(purchaseCards.expiresAt, sql`now()`),
      ),
    )
    .limit(20);
  let closed = 0;
  for (const card of expired) {
    if (!deps.cardIssuer) break;
    try {
      await deps.cardIssuer.close(card.token);
    } catch (err) {
      deps.log.warn({ err, purchaseId: card.purchaseId }, "expired card not closed");
      continue;
    }
    await db.transaction(async (tx) => {
      await tx
        .update(purchaseCards)
        .set({ state: "CLOSED" })
        .where(
          and(
            eq(purchaseCards.purchaseId, card.purchaseId),
            inArray(purchaseCards.state, ["PAUSED", "OPEN"]),
          ),
        );
      await tx
        .update(purchases)
        .set({ state: "FAILED", failureReason: "card:expired", updatedAt: sql`now()` })
        .where(
          and(
            eq(purchases.id, card.purchaseId),
            inArray(purchases.state, ["COUNTERSIGNED", "LOGGED", "COVERED"]),
          ),
        );
    });
    closed++;
  }
  return closed;
}
