import { type CurrencyCode, fromPayPalValue, toPayPalValue } from "@keelson/core";
import {
  and,
  type Db,
  eq,
  gt,
  inArray,
  isNull,
  mandates,
  purchaseHolds,
  purchases,
  sql,
  transition,
} from "@keelson/db";
import {
  checkAuthorization,
  HoldMismatchError,
  ids,
  isAuthorizationGone,
  PayPalError,
} from "@keelson/paypal";
import type { Logger } from "pino";
import type { RedisClientType } from "redis";
import { call, type PayPalDeps } from "../paypal.ts";
import { activateHold, expectedHold, type MandateRow, publishHold } from "./state.ts";

const DAY_MS = 86_400_000;
/** PayPal guarantees the funds for three days; a reauthorization renews that. */
const HONOR_PERIOD_MS = 3 * DAY_MS;
const AUTHORIZATION_LIFETIME_MS = 29 * DAY_MS;
/** The hold is voided this long before PayPal expires it. */
const EXPIRY_MARGIN_MS = 3_600_000;
/** No reauthorization is attempted in the authorization's last day. */
const REAUTHORIZE_MARGIN_MS = DAY_MS;
const MAINTENANCE_INTERVAL_MS = 600_000;
/** A countersigned purchase may be captured until its countersign expires. */
const IN_FLIGHT_MS = 900_000;

/** Purchase states in which a countersign, and then a capture against the hold, may still follow. */
const IN_FLIGHT = ["PROPOSED", "EVALUATING", "COUNTERSIGNED", "LOGGED", "COVERED"] as const;
const LIVE = ["HOLD_PENDING", "ACTIVE"] as const;
const ENDED = ["EXHAUSTED", "EXPIRED", "REVOKED"] as const;
/** Captures that count against the budget. */
const CAPTURED = new Set(["COMPLETED", "PENDING"]);
/** Authorization states PayPal reaches when an authorization is voided or lapses. */
const GONE = new Set<string>(["VOIDED", "EXPIRED"]);
/** Authorization states in which nothing is held any more. */
const RELEASED = new Set(["VOIDED", "EXPIRED", "CAPTURED", "DENIED"]);

export interface HoldDeps {
  db: Db;
  kv: RedisClientType;
  log: Logger;
  paypal: PayPalDeps;
}

async function mandate(db: Db, id: string): Promise<MandateRow | undefined> {
  const [row] = await db.select().from(mandates).where(eq(mandates.id, id));
  return row;
}

async function inFlight(db: Db, mandateId: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: purchases.id })
    .from(purchases)
    .where(
      and(
        eq(purchases.mandateId, mandateId),
        inArray(purchases.state, [...IN_FLIGHT]),
        gt(purchases.updatedAt, new Date(now.getTime() - IN_FLIGHT_MS)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Voids `authorizationId`; resolves to `false` when PayPal had already released it. */
export async function voidAuthorization(
  paypal: PayPalDeps,
  authorizationId: string,
): Promise<boolean> {
  try {
    await call(
      paypal.paypal.payments.voidPayment({
        authorizationId,
        paypalRequestId: ids.operationRequestId(authorizationId, "void"),
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof PayPalError && isAuthorizationGone(err)) return false;
    throw err;
  }
}

/** The authorizations PayPal created for `orderId`; none when the order is gone. */
async function orderAuthorizations(paypal: PayPalDeps, orderId: string): Promise<string[]> {
  const order = await call(paypal.paypal.orders.getOrder({ id: orderId })).catch((err: unknown) => {
    if (err instanceof PayPalError && err.status === 404) return undefined;
    throw err;
  });
  return (order?.purchaseUnits ?? []).flatMap((u) =>
    (u.payments?.authorizations ?? []).flatMap((a) => (a.id ? [a.id] : [])),
  );
}

/**
 * Voids every per-purchase hold of a mandate that may hold funds: the authorized ones, and the
 * pending ones whose order was authorized (the id may be stored, or only PayPal may know it).
 * Each is marked `VOIDED`. Resolves to whether PayPal voided anything.
 */
async function releasePurchaseHolds(deps: HoldDeps, mandateId: string): Promise<boolean> {
  const held = await deps.db
    .select()
    .from(purchaseHolds)
    .where(
      and(
        eq(purchaseHolds.mandateId, mandateId),
        inArray(purchaseHolds.state, ["PENDING", "AUTHORIZED"]),
      ),
    );
  let voided = false;
  for (const h of held) {
    const authorizations = new Set(h.paypalAuthorizationId ? [h.paypalAuthorizationId] : []);
    if (h.state === "PENDING") {
      for (const id of await orderAuthorizations(deps.paypal, h.paypalOrderId)) {
        authorizations.add(id);
      }
    }
    for (const id of authorizations) {
      if (await voidAuthorization(deps.paypal, id)) voided = true;
    }
    await deps.db
      .update(purchaseHolds)
      .set({ state: "VOIDED", updatedAt: sql`now()` })
      .where(and(eq(purchaseHolds.requestId, h.requestId), eq(purchaseHolds.state, h.state)));
  }
  return voided;
}

/**
 * Releases a mandate's hold and ends the mandate as `to`. Waits while a purchase of the mandate
 * may still be countersigned or captured. A void always targets the original authorization:
 * PayPal refuses to void a reauthorization (`CANNOT_BE_VOIDED`). A pending hold is read from its
 * order, so an authorization Keelson never stored is voided too. A mandate exhausted by a final
 * capture needs no void. Resolves to `already` when the hold or the mandate was released by
 * someone else.
 */
export async function voidHold(
  deps: HoldDeps,
  mandateId: string,
  to: "EXHAUSTED" | "REVOKED" | "EXPIRED",
  now: Date = new Date(),
): Promise<"voided" | "waiting" | "already"> {
  const row = await mandate(deps.db, mandateId);
  const from = row?.state;
  if (!row || (from !== "ACTIVE" && from !== "HOLD_PENDING")) return "already";
  if (to === "EXHAUSTED" && from !== "ACTIVE") return "already";
  if (await inFlight(deps.db, mandateId, now)) return "waiting";

  let voided = false;
  try {
    if (row.holdMode === "per_purchase") {
      voided = await releasePurchaseHolds(deps, mandateId);
    } else if (from === "HOLD_PENDING") {
      const authorizations = new Set(
        row.paypalParentAuthorizationId ? [row.paypalParentAuthorizationId] : [],
      );
      if (row.paypalOrderId) {
        for (const id of await orderAuthorizations(deps.paypal, row.paypalOrderId)) {
          authorizations.add(id);
        }
      }
      for (const id of authorizations) {
        if (await voidAuthorization(deps.paypal, id)) voided = true;
      }
    } else if (row.paypalParentAuthorizationId) {
      const current = await call(
        deps.paypal.paypal.payments.getAuthorizedPayment({
          authorizationId: row.paypalAuthorizationId ?? row.paypalParentAuthorizationId,
        }),
      );
      if (!RELEASED.has(current.status ?? "")) {
        voided = await voidAuthorization(deps.paypal, row.paypalParentAuthorizationId);
      }
    }
  } catch (err) {
    await recordError(deps.db, mandateId, err);
    throw err;
  }

  const patch = voided ? { voidedAt: now } : {};
  const moved =
    from === "ACTIVE"
      ? await transition(deps.db, "mandates", mandateId, "ACTIVE", to, patch)
      : await transition(
          deps.db,
          "mandates",
          mandateId,
          "HOLD_PENDING",
          to as "REVOKED" | "EXPIRED",
          patch,
        );
  if (!moved) return "already";
  // A cart authorized while the mandate was still live, after the first pass read its holds.
  if (row.holdMode === "per_purchase" && (await releasePurchaseHolds(deps, mandateId))) {
    voided = true;
  }
  await publishHold(deps, row, { state: to });
  return voided || !row.paypalParentAuthorizationId ? "voided" : "already";
}

async function recordError(db: Db, mandateId: string, err: unknown): Promise<void> {
  if (!(err instanceof PayPalError)) return;
  await db
    .update(mandates)
    .set({ holdError: err.details[0]?.issue ?? err.name, updatedAt: sql`now()` })
    .where(eq(mandates.id, mandateId));
}

/**
 * Reauthorizes a mandate hold once, from day 4 of its authorization, for what is left of the
 * budget: the remaining budget, bounded by the budget less what PayPal shows captured on the
 * order. PayPal returns a new authorization id, which captures use from then on; the original
 * stays the one voids target. A refusal is recorded and not retried: the original authorization
 * stays capturable until it expires.
 *
 * The new authorization must hold exactly the amount asked, in the mandate's currency, under the
 * original's `custom_id` and payee (the original was checked against the signed mandate). One
 * that does not is recorded as `reauthorization-mismatch:<field>` and not used. It is not voided:
 * PayPal voids a reauthorization only through its parent, which would release the hold the user
 * approved; it ends with the parent's void when the mandate ends.
 *
 * @public
 */
export async function reauthorizeHold(
  deps: HoldDeps,
  mandateId: string,
  now: Date = new Date(),
): Promise<"reauthorized" | "refused" | "skipped"> {
  const row = await mandate(deps.db, mandateId);
  const age = row?.authorizedAt ? now.getTime() - row.authorizedAt.getTime() : -1;
  if (
    !row?.paypalAuthorizationId ||
    !row.paypalParentAuthorizationId ||
    !row.paypalOrderId ||
    row.state !== "ACTIVE" ||
    row.holdMode !== "mandate" ||
    row.reauthorizedAt !== null ||
    row.revokeRequestedAt !== null ||
    age < HONOR_PERIOD_MS ||
    age >= AUTHORIZATION_LIFETIME_MS - REAUTHORIZE_MARGIN_MS ||
    row.remainingMinor <= 0n ||
    (await inFlight(deps.db, mandateId, now))
  ) {
    return "skipped";
  }
  const { paypal } = deps.paypal;
  const current = row.paypalAuthorizationId;
  const parent = row.paypalParentAuthorizationId;
  const currency = row.currency as CurrencyCode;
  /** Spends the one reauthorization without one, keeping the current authorization. */
  const giveUp = async (holdError: string) => {
    await deps.db
      .update(mandates)
      .set({ holdError, reauthorizedAt: now, updatedAt: sql`now()` })
      .where(and(eq(mandates.id, mandateId), isNull(mandates.reauthorizedAt)));
    deps.log.warn({ mandateId, authorizationId: current, holdError }, "hold not reauthorized");
  };

  const order = await call(paypal.orders.getOrder({ id: row.paypalOrderId }));
  let captured = 0n;
  for (const capture of (order.purchaseUnits ?? []).flatMap((u) => u.payments?.captures ?? [])) {
    if (!CAPTURED.has(capture.status ?? "")) continue;
    if (capture.amount?.currencyCode !== currency || !capture.amount.value) {
      throw new Error(
        `capture ${capture.id} of order ${row.paypalOrderId} has no ${currency} amount`,
      );
    }
    captured += fromPayPalValue(currency, capture.amount.value).minor;
  }
  const left = row.maxMinor - captured;
  let amount = row.remainingMinor;
  if (left < amount) amount = left;
  if (amount <= 0n) {
    await giveUp("nothing-to-reauthorize");
    return "skipped";
  }

  const original = await call(paypal.payments.getAuthorizedPayment({ authorizationId: parent }));
  try {
    const renewed = await call(
      paypal.payments.reauthorizePayment({
        authorizationId: current,
        paypalRequestId: ids.operationRequestId(parent, "reauthorize"),
        body: {
          amount: { currencyCode: currency, value: toPayPalValue({ currency, minor: amount }) },
        },
      }),
    );
    if (!renewed.id) throw new Error(`PayPal reauthorized ${current} without an id`);
    const child = await call(paypal.payments.getAuthorizedPayment({ authorizationId: renewed.id }));
    try {
      checkAuthorization(child, {
        customId: original.customId ?? "",
        amount: { currency, minor: amount },
        payees: original.payee?.merchantId ? [original.payee.merchantId] : [],
      });
    } catch (err) {
      if (!(err instanceof HoldMismatchError)) throw err;
      await giveUp(`reauthorization-mismatch:${err.field}`);
      return "refused";
    }
    await deps.db
      .update(mandates)
      .set({ paypalAuthorizationId: renewed.id, reauthorizedAt: now, updatedAt: sql`now()` })
      .where(and(eq(mandates.id, mandateId), eq(mandates.paypalAuthorizationId, current)));
    deps.log.info({ mandateId, parent, authorizationId: renewed.id }, "hold reauthorized");
    return "reauthorized";
  } catch (err) {
    const issue =
      err instanceof PayPalError
        ? err.details.find((d) => d.issue.startsWith("REAUTHORIZATION_"))?.issue
        : undefined;
    if (issue === undefined) throw err;
    await giveUp(issue);
    return "refused";
  }
}

interface Reconciled {
  effect: "applied" | "unchanged" | "mismatch";
  /** What PayPal answered the re-read with. */
  resource: unknown;
}

/** What a hold ends with when PayPal no longer has its order or authorization. */
const NOT_FOUND = "NOT_FOUND";

/**
 * Resolves to `undefined` when PayPal answers 404 for an order or authorization it no longer
 * keeps, such as a sandbox order never approved; rethrows anything else.
 */
function absent(err: unknown): undefined {
  if (err instanceof PayPalError && err.status === 404) return undefined;
  throw err;
}

/**
 * Re-reads a mandate's hold from PayPal with authenticated GETs and applies only what the re-read
 * shows: a pending hold whose authorization was created becomes `ACTIVE` (after the same checks
 * as authorizing it), and a hold voided or expired outside Keelson ends the mandate as `EXPIRED`.
 * A webhook never changes state by itself; it calls this.
 *
 * @public
 */
export async function reconcileHold(deps: HoldDeps, mandateId: string): Promise<Reconciled> {
  const row = await mandate(deps.db, mandateId);
  const { paypal } = deps.paypal;
  if (!row || (row.state !== "HOLD_PENDING" && row.state !== "ACTIVE")) {
    return { effect: "unchanged", resource: null };
  }

  if (row.holdMode === "per_purchase") {
    const held = await deps.db
      .select()
      .from(purchaseHolds)
      .where(
        and(
          eq(purchaseHolds.mandateId, mandateId),
          inArray(purchaseHolds.state, ["PENDING", "AUTHORIZED"]),
        ),
      );
    const resource: unknown[] = [];
    let effect: Reconciled["effect"] = "unchanged";
    for (const h of held) {
      if (!h.paypalAuthorizationId) continue;
      const auth = await call(
        paypal.payments.getAuthorizedPayment({ authorizationId: h.paypalAuthorizationId }),
      );
      resource.push(auth);
      if (!GONE.has(auth.status ?? "")) continue;
      const updated = await deps.db
        .update(purchaseHolds)
        .set({ state: "VOIDED", updatedAt: sql`now()` })
        .where(and(eq(purchaseHolds.requestId, h.requestId), eq(purchaseHolds.state, h.state)));
      if (updated.rowCount === 1) effect = "applied";
    }
    return { effect, resource };
  }

  const expire = async (status: string) =>
    row.state === "ACTIVE"
      ? transition(deps.db, "mandates", mandateId, "ACTIVE", "EXPIRED", {
          holdError: `paypal:${status}`,
        })
      : transition(deps.db, "mandates", mandateId, "HOLD_PENDING", "EXPIRED", {
          holdError: `paypal:${status}`,
        });
  const ended = async (status: string, resource: unknown): Promise<Reconciled> => {
    if (!(await expire(status))) return { effect: "unchanged", resource };
    await publishHold(deps, row, { state: "EXPIRED" });
    return { effect: "applied", resource };
  };

  if (row.state === "ACTIVE") {
    if (!row.paypalAuthorizationId) return { effect: "unchanged", resource: null };
    const auth = await call(
      paypal.payments.getAuthorizedPayment({ authorizationId: row.paypalAuthorizationId }),
    ).catch(absent);
    if (!auth) {
      if (row.voidedAt !== null) return { effect: "unchanged", resource: null };
      return ended(NOT_FOUND, null);
    }
    const status = auth.status ?? "";
    if (GONE.has(status) && row.voidedAt === null) {
      return ended(status, auth);
    }
    return { effect: "unchanged", resource: auth };
  }

  if (!row.paypalOrderId) return { effect: "unchanged", resource: null };
  const order = await call(paypal.orders.getOrder({ id: row.paypalOrderId })).catch(absent);
  if (!order) return ended(NOT_FOUND, null);
  const authorization = order.purchaseUnits?.[0]?.payments?.authorizations?.[0];
  const status: string | undefined =
    authorization?.status ?? (order.status === "VOIDED" ? "VOIDED" : undefined);
  if (status !== undefined && GONE.has(status)) return ended(status, order);
  if (status !== "CREATED" || !authorization?.id) return { effect: "unchanged", resource: order };
  const auth = await call(
    paypal.payments.getAuthorizedPayment({ authorizationId: authorization.id }),
  );
  try {
    const checked = checkAuthorization(auth, expectedHold(deps.paypal, row));
    return {
      effect: (await activateHold(deps, row, checked)) ? "applied" : "unchanged",
      resource: auth,
    };
  } catch (err) {
    if (!(err instanceof HoldMismatchError)) throw err;
    deps.log.warn(
      { mandateId, authorizationId: authorization.id, field: err.field },
      "hold mismatch",
    );
    return { effect: "mismatch", resource: auth };
  }
}

async function due(db: Db, where: ReturnType<typeof and>): Promise<string[]> {
  return (await db.select({ id: mandates.id }).from(mandates).where(where)).map((r) => r.id);
}

/**
 * One pass of hold maintenance: reconciles pending holds, reauthorizes due ones, voids
 * expiring, exhausted and revoked ones, and voids cart holds an ended mandate still has. Every step is idempotent, so overlapping instances are
 * harmless. Resolves to how many steps failed.
 *
 * @internal
 */
export async function maintainHolds(deps: HoldDeps, now: Date = new Date()): Promise<number> {
  const { db, log } = deps;
  const at = (ms: number) => new Date(now.getTime() - ms);
  let failed = 0;
  const each = async (ids: string[], step: string, run: (id: string) => Promise<unknown>) => {
    for (const id of ids) {
      try {
        const result = await run(id);
        log.debug({ mandateId: id, step, result }, "hold maintenance");
      } catch (err) {
        failed++;
        log.error({ err, mandateId: id, step }, "hold maintenance failed");
      }
    }
  };

  await each(
    await due(
      db,
      and(eq(mandates.state, "HOLD_PENDING"), sql`${mandates.paypalOrderId} is not null`),
    ),
    "reconcile",
    (id) => reconcileHold(deps, id),
  );
  await each(
    await due(
      db,
      and(
        eq(mandates.state, "ACTIVE"),
        eq(mandates.holdMode, "mandate"),
        isNull(mandates.reauthorizedAt),
        sql`${mandates.authorizedAt} <= ${at(HONOR_PERIOD_MS)}`,
      ),
    ),
    "reauthorize",
    (id) => reauthorizeHold(deps, id, now),
  );
  await each(
    await due(
      db,
      and(
        inArray(mandates.state, [...LIVE]),
        sql`(${mandates.expiresAt} <= ${now} or ${mandates.authorizedAt} <= ${at(AUTHORIZATION_LIFETIME_MS - EXPIRY_MARGIN_MS)})`,
      ),
    ),
    "expire",
    (id) => voidHold(deps, id, "EXPIRED", now),
  );
  await each(
    await due(db, and(eq(mandates.state, "ACTIVE"), eq(mandates.remainingMinor, 0n))),
    "exhaust",
    (id) => voidHold(deps, id, "EXHAUSTED", now),
  );
  await each(
    await due(
      db,
      and(inArray(mandates.state, [...LIVE]), sql`${mandates.revokeRequestedAt} is not null`),
    ),
    "revoke",
    (id) => voidHold(deps, id, "REVOKED", now),
  );
  await each(
    await due(
      db,
      and(
        eq(mandates.holdMode, "per_purchase"),
        inArray(mandates.state, [...ENDED]),
        sql`exists (select 1 from ${purchaseHolds} where ${purchaseHolds.mandateId} = ${mandates.id} and ${purchaseHolds.state} in ('PENDING', 'AUTHORIZED'))`,
      ),
    ),
    "release",
    async (id) => ((await inFlight(db, id, now)) ? "waiting" : releasePurchaseHolds(deps, id)),
  );
  return failed;
}

/** Runs `maintainHolds` every ten minutes; returns the function that stops it. */
export function startHoldMaintenance(deps: HoldDeps): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    maintainHolds(deps)
      .then(
        (failed) => {
          if (failed > 0) deps.log.warn({ failed }, "hold maintenance had failures");
        },
        (err: unknown) => deps.log.error({ err }, "hold maintenance failed"),
      )
      .finally(() => {
        running = false;
      });
  }, MAINTENANCE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
