import { toPayPalValue } from "@keelson/core";
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

/** Purchase states in which a capture against the hold may still follow. */
const IN_FLIGHT = ["COUNTERSIGNED", "LOGGED", "COVERED"] as const;
const LIVE = ["HOLD_PENDING", "ACTIVE"] as const;
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
async function voidAuthorization(paypal: PayPalDeps, authorizationId: string): Promise<boolean> {
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

/**
 * Releases a mandate's hold and ends the mandate as `to`. Waits while a purchase of the mandate
 * may still be captured. A void always targets the original authorization: PayPal refuses to
 * void a reauthorization (`CANNOT_BE_VOIDED`). A mandate exhausted by a final capture needs no
 * void. Resolves to `already` when the hold or the mandate was released by someone else.
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
      const held = await deps.db
        .select()
        .from(purchaseHolds)
        .where(and(eq(purchaseHolds.mandateId, mandateId), eq(purchaseHolds.state, "AUTHORIZED")));
      for (const h of held) {
        if (
          h.paypalAuthorizationId &&
          (await voidAuthorization(deps.paypal, h.paypalAuthorizationId))
        )
          voided = true;
        await deps.db
          .update(purchaseHolds)
          .set({ state: "VOIDED", updatedAt: sql`now()` })
          .where(
            and(eq(purchaseHolds.requestId, h.requestId), eq(purchaseHolds.state, "AUTHORIZED")),
          );
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
    if (err instanceof PayPalError) {
      await deps.db
        .update(mandates)
        .set({ holdError: err.details[0]?.issue ?? err.name, updatedAt: sql`now()` })
        .where(eq(mandates.id, mandateId));
    }
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
  await publishHold(deps, row, { state: to });
  return voided || !row.paypalParentAuthorizationId ? "voided" : "already";
}

/**
 * Reauthorizes a mandate hold once, from day 4 of its authorization, for what remains of the
 * budget. PayPal returns a new authorization id, which captures use from then on; the original
 * stays the one voids target. A refusal is recorded and not retried: the original authorization
 * stays capturable until it expires.
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
  const current = row.paypalAuthorizationId;
  try {
    const renewed = await call(
      deps.paypal.paypal.payments.reauthorizePayment({
        authorizationId: current,
        paypalRequestId: ids.operationRequestId(row.paypalParentAuthorizationId, "reauthorize"),
        body: {
          amount: {
            currencyCode: row.currency,
            value: toPayPalValue({
              currency: row.currency as Parameters<typeof toPayPalValue>[0]["currency"],
              minor: row.remainingMinor,
            }),
          },
        },
      }),
    );
    if (!renewed.id) throw new Error(`PayPal reauthorized ${current} without an id`);
    await deps.db
      .update(mandates)
      .set({ paypalAuthorizationId: renewed.id, reauthorizedAt: now, updatedAt: sql`now()` })
      .where(and(eq(mandates.id, mandateId), eq(mandates.paypalAuthorizationId, current)));
    deps.log.info({ mandateId, parent: current, authorizationId: renewed.id }, "hold reauthorized");
    return "reauthorized";
  } catch (err) {
    if (
      !(err instanceof PayPalError) ||
      !err.details.some((d) => d.issue.startsWith("REAUTHORIZATION_"))
    )
      throw err;
    const issue = err.details.find((d) => d.issue.startsWith("REAUTHORIZATION_"))?.issue as string;
    await deps.db
      .update(mandates)
      .set({ holdError: issue, reauthorizedAt: now, updatedAt: sql`now()` })
      .where(and(eq(mandates.id, mandateId), isNull(mandates.reauthorizedAt)));
    deps.log.warn({ mandateId, authorizationId: current, issue }, "hold reauthorization refused");
    return "refused";
  }
}

interface Reconciled {
  effect: "applied" | "unchanged" | "mismatch";
  /** What PayPal answered the re-read with. */
  resource: unknown;
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
    );
    const status = auth.status ?? "";
    if (GONE.has(status) && row.voidedAt === null) {
      return ended(status, auth);
    }
    return { effect: "unchanged", resource: auth };
  }

  if (!row.paypalOrderId) return { effect: "unchanged", resource: null };
  const order = await call(paypal.orders.getOrder({ id: row.paypalOrderId }));
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
 * One pass of hold maintenance: reconciles pending holds, reauthorizes due ones and voids
 * expiring, exhausted and revoked ones. Every step is idempotent, so overlapping instances are
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
