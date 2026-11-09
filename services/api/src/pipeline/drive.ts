import { and, type Db, eq, inArray, isNull, lt, or, purchases, sql } from "@keelson/db";
import type { Relayer } from "@keelson/relayer";
import type { Logger } from "pino";
import type { RedisClientType } from "redis";
import { type Hex, type PublicClient, toHex } from "viem";
import type { LogConfig } from "../log/append.ts";
import type { OperatorSigners } from "../operators/signer.ts";
import type { PayPalDeps } from "../paypal.ts";
import type { CountersignJson } from "../tee/client.ts";
import type { TeeConfig } from "../tee/signers.ts";
import type { StampWorker } from "../timestamps/worker.ts";
import { CAPTURE_WINDOW_SEC, captureStep } from "./capture-step.ts";
import { coverStep } from "./cover-step.ts";
import { publishPurchase } from "./events.ts";
import { logStep } from "./log-step.ts";
import type { Outcome } from "./outcome.ts";

const LEASE_SEC = 20;
const HEARTBEAT_MS = 5_000;
const DRIVEN = ["COUNTERSIGNED", "LOGGED", "COVERED"] as const;
const RESUME_BATCH = 20;
const CHAIN_ID = 421614;

export interface PipelineDeps {
  db: Db;
  kv: RedisClientType;
  log: Logger;
  tlog?: LogConfig | undefined;
  stamps?: StampWorker | undefined;
  relayer?: Relayer | undefined;
  operators?: OperatorSigners | undefined;
  chain?: { client: PublicClient } | undefined;
  paypal?: PayPalDeps | undefined;
  tee?: Pick<TeeConfig, "client"> | undefined;
}

/** What `POST /v1/countersign` and `GET /v1/purchases/{id}` say about a purchase. */
export interface PurchaseView {
  id: string;
  mandateId: string;
  state: string;
  mode: "2of2" | "degraded" | null;
  amount: { currency: string; minor: string };
  logIndex?: string;
  coverage?: { chainId: number; txHash: Hex | null };
  capture?: { id: string; invoiceId: string; status: string | null };
  failure?: { step: string; reason: string };
}

type Row = typeof purchases.$inferSelect;

export function purchaseView(p: Row): PurchaseView {
  const failure = p.state === "FAILED" && p.failureReason ? p.failureReason : undefined;
  const [step = "countersign", ...rest] = failure?.includes(":") ? failure.split(":") : [];
  return {
    id: p.id,
    mandateId: p.mandateId,
    state: p.state,
    mode: (p.countersignMode as PurchaseView["mode"]) ?? null,
    amount: { currency: p.currency, minor: p.amountMinor.toString() },
    ...(p.logIndex !== null ? { logIndex: p.logIndex.toString() } : {}),
    ...(p.coverageTxId !== null
      ? {
          coverage: {
            chainId: CHAIN_ID,
            txHash: p.coverageTxHash ? toHex(p.coverageTxHash) : null,
          },
        }
      : {}),
    ...(p.paypalCaptureId && p.invoiceId
      ? { capture: { id: p.paypalCaptureId, invoiceId: p.invoiceId, status: p.captureStatus } }
      : {}),
    ...(failure
      ? { failure: rest.length > 0 ? { step, reason: rest.join(":") } : { step, reason: failure } }
      : {}),
  };
}

export async function viewOf(db: Db, purchaseId: string): Promise<PurchaseView | undefined> {
  const [p] = await db.select().from(purchases).where(eq(purchases.id, purchaseId));
  return p ? purchaseView(p) : undefined;
}

/**
 * Takes the purchase for `LEASE_SEC` if no other driver holds it and it still has steps to run.
 * The lease's expiry, as Postgres prints it, is the driver's token: only its holder renews or
 * releases it.
 */
async function lease(db: Db, purchaseId: string): Promise<{ row: Row; token: string } | undefined> {
  const [taken] = await db
    .update(purchases)
    .set({ leaseUntil: sql`now() + make_interval(secs => ${LEASE_SEC})` })
    .where(
      and(
        eq(purchases.id, purchaseId),
        inArray(purchases.state, [...DRIVEN]),
        or(isNull(purchases.leaseUntil), lt(purchases.leaseUntil, sql`now()`)),
      ),
    )
    .returning({ id: purchases.id, token: sql<string>`${purchases.leaseUntil}::text` });
  if (!taken) return undefined;
  const [row] = await db.select().from(purchases).where(eq(purchases.id, purchaseId));
  return row ? { row, token: taken.token } : undefined;
}

const held = (purchaseId: string, token: string) =>
  and(eq(purchases.id, purchaseId), sql`${purchases.leaseUntil} = ${token}::timestamptz`);

async function renew(db: Db, purchaseId: string, token: string): Promise<string | undefined> {
  const [r] = await db
    .update(purchases)
    .set({ leaseUntil: sql`now() + make_interval(secs => ${LEASE_SEC})` })
    .where(held(purchaseId, token))
    .returning({ token: sql<string>`${purchases.leaseUntil}::text` });
  return r?.token;
}

async function fail(
  deps: PipelineDeps,
  purchaseId: string,
  from: (typeof DRIVEN)[number],
  reason: string,
): Promise<void> {
  const moved = await deps.db
    .update(purchases)
    .set({ state: "FAILED", failureReason: reason, updatedAt: sql`now()` })
    .where(and(eq(purchases.id, purchaseId), eq(purchases.state, from)))
    .returning({ id: purchases.id });
  if (moved.length === 0) return;
  const [step = "pipeline", ...code] = reason.split(":");
  deps.log.warn({ purchaseId, reason }, "purchase failed");
  await publishPurchase(deps, purchaseId, {
    type: "purchase.failed",
    step,
    reason: code.join(":") || reason,
  });
}

/** Runs a step; a step that throws is retried on the next drive, as a timeout would be. */
async function run<T>(
  deps: PipelineDeps,
  purchaseId: string,
  step: string,
  f: () => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
  try {
    return await f();
  } catch (err) {
    deps.log.error({ err, purchaseId, step }, "purchase step failed");
    return { kind: "retry", reason: `${step}:error` };
  }
}

/**
 * Carries a countersigned purchase as far as it can go: its leaf to the log and its coverage on
 * chain, in parallel, then the capture once both are recorded. Every step is idempotent, so a
 * purchase whose driver died is driven again from what its row says.
 */
export async function drivePurchase(deps: PipelineDeps, purchaseId: string): Promise<PurchaseView> {
  const taken = await lease(deps.db, purchaseId);
  if (!taken) return (await viewOf(deps.db, purchaseId)) as PurchaseView;
  const { row } = taken;
  let token = taken.token;
  let lost = false;
  // Steps can outlast the lease; a heartbeat keeps it while this driver is alive.
  const heartbeat = setInterval(() => {
    void renew(deps.db, purchaseId, token).then(
      (t) => {
        if (t) token = t;
        else lost = true;
      },
      (err: unknown) => deps.log.warn({ err, purchaseId }, "lease not renewed"),
    );
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    const cs = row.countersign as unknown as CountersignJson | null;
    // Rows stored before the countersign message was kept, or with an unreadable one, can be
    // neither logged nor covered, and no capture window can be computed for them.
    if (!Number.isSafeInteger(Number(cs?.issuedAt))) {
      await fail(deps, purchaseId, row.state as (typeof DRIVEN)[number], "pipeline:no-countersign");
      return (await viewOf(deps.db, purchaseId)) as PurchaseView;
    }
    const windowClosed = () => Date.now() / 1000 >= Number(cs?.issuedAt) + CAPTURE_WINDOW_SEC;
    let state = row.state as (typeof DRIVEN)[number];

    if (state === "COUNTERSIGNED" || state === "LOGGED") {
      const logged =
        state === "COUNTERSIGNED"
          ? run(deps, purchaseId, "log", () => logStep(deps, purchaseId)).then(async (out) => {
              if (out.kind !== "done") return out;
              await deps.db
                .update(purchases)
                .set({ state: "LOGGED", updatedAt: sql`now()` })
                .where(and(eq(purchases.id, purchaseId), eq(purchases.state, "COUNTERSIGNED")));
              await publishPurchase(deps, purchaseId, {
                type: "purchase.logged",
                logIndex: out.value.index.toString(),
                leafHash: toHex(out.value.leafHash),
              });
              return out;
            })
          : Promise.resolve({ kind: "done" } as const);
      const covered = run(deps, purchaseId, "cover", () => coverStep(deps, purchaseId));
      const [log, cover] = await Promise.all([logged, covered]);
      for (const out of [log, cover]) {
        if (out.kind === "final") {
          const [now] = await deps.db
            .select({ state: purchases.state })
            .from(purchases)
            .where(eq(purchases.id, purchaseId));
          await fail(deps, purchaseId, now?.state as (typeof DRIVEN)[number], out.reason);
          return (await viewOf(deps.db, purchaseId)) as PurchaseView;
        }
      }
      if (log.kind === "retry" || cover.kind === "retry") {
        if (windowClosed()) {
          const reason = log.kind === "retry" ? log.reason : (cover as { reason: string }).reason;
          await fail(
            deps,
            purchaseId,
            log.kind === "retry" ? "COUNTERSIGNED" : "LOGGED",
            `${reason.split(":")[0]}:window-closed`,
          );
        }
        return (await viewOf(deps.db, purchaseId)) as PurchaseView;
      }
      if (cover.kind !== "done") throw new Error("unreachable");
      const moved = await deps.db
        .update(purchases)
        .set({ state: "COVERED", updatedAt: sql`now()` })
        .where(
          and(
            eq(purchases.id, purchaseId),
            eq(purchases.state, "LOGGED"),
            sql`${purchases.logIndex} is not null`,
          ),
        )
        .returning({ id: purchases.id });
      if (moved.length === 0) return (await viewOf(deps.db, purchaseId)) as PurchaseView;
      await publishPurchase(deps, purchaseId, {
        type: "purchase.covered",
        chainId: CHAIN_ID,
        txHash: cover.value.txHash,
      });
      state = "COVERED";
      const renewed = await renew(deps.db, purchaseId, token);
      // Another driver took over while this one was slow; it captures, not this one.
      if (!renewed || lost) return (await viewOf(deps.db, purchaseId)) as PurchaseView;
      token = renewed;
    }

    if (lost) return (await viewOf(deps.db, purchaseId)) as PurchaseView;
    const capture = await run(deps, purchaseId, "capture", () => captureStep(deps, purchaseId));
    if (capture.kind === "final") await fail(deps, purchaseId, "COVERED", capture.reason);
    return (await viewOf(deps.db, purchaseId)) as PurchaseView;
  } finally {
    clearInterval(heartbeat);
    await deps.db
      .update(purchases)
      .set({ leaseUntil: null })
      .where(held(purchaseId, token))
      .catch((err: unknown) => deps.log.error({ err, purchaseId }, "lease not released"));
  }
}

/**
 * Drives the purchases whose driver is gone: in a driven state with no live lease. Returns how
 * many it drove.
 */
export async function resumePurchases(deps: PipelineDeps): Promise<number> {
  const rows = await deps.db
    .select({ id: purchases.id })
    .from(purchases)
    .where(
      and(
        inArray(purchases.state, [...DRIVEN]),
        or(
          lt(purchases.leaseUntil, sql`now()`),
          and(
            isNull(purchases.leaseUntil),
            lt(purchases.updatedAt, sql`now() - make_interval(secs => ${LEASE_SEC})`),
          ),
        ),
      ),
    )
    .limit(RESUME_BATCH);
  await Promise.all(rows.map((r) => drivePurchase(deps, r.id)));
  return rows.length;
}

/** Logs the DENY purchases whose leaf is not in the log yet. Returns how many it logged. */
export async function logDenials(deps: PipelineDeps): Promise<number> {
  const rows = await deps.db
    .select({ id: purchases.id })
    .from(purchases)
    .where(
      and(
        eq(purchases.state, "DENIED"),
        isNull(purchases.logIndex),
        sql`${purchases.countersign} is not null`,
        sql`${purchases.paypalRefSalt} is not null`,
        isNull(purchases.failureReason),
        lt(purchases.updatedAt, sql`now() - make_interval(secs => ${LEASE_SEC})`),
        sql`${purchases.createdAt} > now() - interval '1 day'`,
      ),
    )
    .limit(RESUME_BATCH);
  let logged = 0;
  for (const r of rows) {
    const out = await run(deps, r.id, "log", () => logStep(deps, r.id));
    if (out.kind === "done") logged++;
    // A DENY stays DENIED; the reason only stops the sweeper offering a leaf the log refused.
    if (out.kind === "final") {
      await deps.db
        .update(purchases)
        .set({ failureReason: out.reason })
        .where(eq(purchases.id, r.id));
    }
  }
  return logged;
}
