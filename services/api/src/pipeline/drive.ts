import {
  and,
  cardAuthorizations,
  cardChargebacks,
  type Db,
  eq,
  inArray,
  isNull,
  lt,
  or,
  purchaseCards,
  purchases,
  sql,
} from "@keelson/db";
import type { Relayer } from "@keelson/relayer";
import type { Logger } from "pino";
import type { RedisClientType } from "redis";
import { type Hex, type PublicClient, toHex } from "viem";
import { bondClaimMinor, chargebackView } from "../cards/chargeback.ts";
import type { CardIssuer } from "../cards/issuer.ts";
import type { LogConfig } from "../log/append.ts";
import type { Notifier } from "../notify/notifier.ts";
import type { OperatorSigners } from "../operators/signer.ts";
import type { PayPalDeps } from "../paypal.ts";
import type { CountersignJson } from "../tee/client.ts";
import type { TeeConfig } from "../tee/signers.ts";
import type { StampWorker } from "../timestamps/worker.ts";
import { span } from "../tracing.ts";
import { CAPTURE_WINDOW_SEC, captureStep } from "./capture-step.ts";
import { captureCardStep, issueCardStep, openCardStep } from "./card-step.ts";
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
  /** Issues the single-use cards of card purchases; they fail before logging without it. */
  cardIssuer?: CardIssuer | undefined;
  proveAnonymousPurchase?: ((purchaseId: string) => Promise<void>) | undefined;
  notifier?: Notifier | undefined;
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
  blocked?: string[];
  /** For a `DENIED` cart, each failed field with what the mandate allowed and what the cart had. */
  reasons?: BlockReason[];
  /** For a countersigned purchase, each mandate field with both values and that it held. */
  checks?: FieldCheck[];
  /** A purchase the buyer pays at the store's own checkout: the store and PayPal's transaction. */
  live?: { store: string; transactionId: string | null };
  /** A card purchase: its single-use card and each authorization the card network sent it. */
  card?: CardView;
}

/** A purchase's single-use card, as the purchase shows it: never its number. */
export interface CardView {
  issuer: string;
  lastFour: string;
  state: string;
  expiresAt: string;
  controls: Record<string, unknown>;
  settledMinor: string | null;
  /** Chargebacks filed through the issuer, and what a bond claim may still pay after them. */
  chargebacks: ReturnType<typeof chargebackView>[];
  bondClaimMinor: string;
  authorizations: {
    id: string;
    amountMinor: string;
    currency: string;
    mcc: string;
    merchantName: string;
    merchantCountry: string;
    approved: boolean;
    failedMask: number;
    reason: string | null;
    legs: { tdx: boolean; nitro: boolean };
    latencyMs: number;
    at: string;
  }[];
}

type Row = typeof purchases.$inferSelect;

/** The policy ids whose check failed, from the engine's evaluation trace. */
export function failedFields(trace: unknown): string[] {
  const fields = (trace as { fields?: { id?: unknown; pass?: unknown }[] } | null)?.fields;
  if (!Array.isArray(fields)) return [];
  return fields.flatMap((f) => (typeof f.id === "string" && f.pass === false ? [f.id] : []));
}

/** A failed mandate field, its bound and the cart's value, as the buyer reads them. */
interface BlockReason {
  field: string;
  mandate: string | null;
  cart: string | null;
}

interface FieldTrace {
  field?: unknown;
  pass?: unknown;
  observed?: unknown;
  bound?: unknown;
}

const MONEY_FIELDS = new Set(["total", "budget"]);

const day = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(ms);

/** A Cedar JSON value from the engine's trace, as text (`keelson.eval/1`). */
function shown(field: string, value: unknown, currency: string): string | null {
  if (value === null || value === undefined) return null;
  if (MONEY_FIELDS.has(field) && typeof value === "number") {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value / 100);
  }
  if (field === "deadline") {
    const ms =
      typeof value === "number" ? value : (value as { expires_at_ms?: unknown }).expires_at_ms;
    return typeof ms === "number" ? day(ms) : null;
  }
  if (Array.isArray(value)) {
    const parts = value.map((v) => shown(field, v, currency)).filter((v) => v !== null);
    return parts.length > 0 ? parts.join("; ") : null;
  }
  if (typeof value === "object") {
    const parts = Object.entries(value as Record<string, unknown>)
      .filter(([k]) => k !== "sku" && !k.startsWith("__"))
      .map(([k, v]) => `${k.replaceAll("_", " ")} ${String(v)}`);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/** One mandate field as the engine checked it: both values and whether it held. */
export interface FieldCheck extends BlockReason {
  pass: boolean;
}

/**
 * Each mandate field of the engine's evaluation trace, once, with both sides. A field holds only
 * if every policy reading it passed. The cart's own sanity check has no mandate side and is left
 * out.
 */
export function fieldChecks(trace: unknown, currency: string): FieldCheck[] {
  const fields = (trace as { fields?: FieldTrace[] } | null)?.fields;
  if (!Array.isArray(fields)) return [];
  const byField = new Map<string, FieldCheck>();
  for (const f of fields) {
    if (typeof f.field !== "string" || f.field === "cart") continue;
    const seen = byField.get(f.field);
    if (seen) {
      if (f.pass === false && seen.pass) {
        byField.set(f.field, {
          field: f.field,
          mandate: shown(f.field, f.bound, currency),
          cart: shown(f.field, f.observed, currency),
          pass: false,
        });
      }
      continue;
    }
    byField.set(f.field, {
      field: f.field,
      mandate: shown(f.field, f.bound, currency),
      cart: shown(f.field, f.observed, currency),
      pass: f.pass !== false,
    });
  }
  return [...byField.values()];
}

function verdict(p: Row) {
  const checks = fieldChecks(p.evalTrace, p.currency);
  if (p.state !== "DENIED") return checks.length > 0 ? { checks } : {};
  const reasons = checks.filter((c) => !c.pass).map(({ pass: _, ...r }) => r);
  return { blocked: reasons.map((r) => r.field), reasons };
}

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
    ...verdict(p),
    ...(p.liveStore !== null
      ? { live: { store: p.liveStore, transactionId: p.paypalTransactionId } }
      : {}),
  };
}

/** The single-use card of a card purchase and its authorizations, oldest first. */
export async function cardViewOf(db: Db, purchaseId: string): Promise<CardView | undefined> {
  const [card] = await db
    .select()
    .from(purchaseCards)
    .where(eq(purchaseCards.purchaseId, purchaseId));
  if (!card) return undefined;
  const [auths, chargebacks] = await Promise.all([
    db
      .select()
      .from(cardAuthorizations)
      .where(eq(cardAuthorizations.purchaseId, purchaseId))
      .orderBy(cardAuthorizations.createdAt),
    db
      .select()
      .from(cardChargebacks)
      .where(eq(cardChargebacks.purchaseId, purchaseId))
      .orderBy(cardChargebacks.createdAt),
  ]);
  return {
    issuer: card.issuer,
    lastFour: card.lastFour,
    state: card.state,
    expiresAt: card.expiresAt.toISOString(),
    controls: card.controls,
    settledMinor: card.settledMinor?.toString() ?? null,
    chargebacks: chargebacks.map(chargebackView),
    bondClaimMinor: bondClaimMinor(card.settledMinor ?? 0n, chargebacks).toString(),
    authorizations: auths.map((a) => ({
      id: a.id,
      amountMinor: a.amountMinor.toString(),
      currency: a.currency,
      mcc: a.mcc,
      merchantName: a.merchantName,
      merchantCountry: a.merchantCountry,
      approved: a.approved,
      failedMask: a.failedMask,
      reason: a.reason,
      legs: { tdx: a.tdx !== null, nitro: a.nitro !== null },
      latencyMs: a.latencyMs,
      at: a.createdAt.toISOString(),
    })),
  };
}

export async function viewOf(db: Db, purchaseId: string): Promise<PurchaseView | undefined> {
  const [p] = await db.select().from(purchases).where(eq(purchases.id, purchaseId));
  if (!p) return undefined;
  const card = p.rail === "card" ? await cardViewOf(db, purchaseId) : undefined;
  return { ...purchaseView(p), ...(card ? { card } : {}) };
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

const REACHES = {
  card: "CARD_ISSUED",
  log: "LOGGED",
  cover: "COVERED",
  open: "CARD_OPEN",
  capture: "CAPTURED",
} as const;

/**
 * Runs a step in a span named for the state it reaches; a step that throws is retried on the
 * next drive, as a timeout would be.
 */
async function run<T>(
  deps: PipelineDeps,
  purchaseId: string,
  step: keyof typeof REACHES,
  f: () => Promise<Outcome<T>>,
  mode?: string | null,
): Promise<Outcome<T>> {
  try {
    return await span(
      `purchase.${REACHES[step]}`,
      { "purchase.id": purchaseId, ...(mode ? { "countersign.mode": mode } : {}) },
      async (s) => {
        const out = await f();
        s.setAttribute("purchase.outcome", out.kind);
        return out;
      },
    );
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

    const toLog = () =>
      run(deps, purchaseId, "log", () => logStep(deps, purchaseId), row.countersignMode).then(
        async (out) => {
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
        },
      );

    // The buyer pays a live purchase at the store: Keelson logs it and issues its Alibi only.
    if (row.liveStore !== null) {
      if (state === "COUNTERSIGNED") {
        const out = await toLog();
        if (out.kind === "final") await fail(deps, purchaseId, state, out.reason);
        if (out.kind === "retry" && windowClosed()) {
          await fail(deps, purchaseId, state, `${out.reason.split(":")[0]}:window-closed`);
        }
      }
      return (await viewOf(deps.db, purchaseId)) as PurchaseView;
    }

    // A card purchase's card is issued before its leaf is logged, which commits to it.
    if (row.rail === "card" && state === "COUNTERSIGNED") {
      const issued = await run(deps, purchaseId, "card", () => issueCardStep(deps, purchaseId));
      if (issued.kind === "final") {
        await fail(deps, purchaseId, state, issued.reason);
        return (await viewOf(deps.db, purchaseId)) as PurchaseView;
      }
      if (issued.kind === "retry") {
        if (windowClosed()) await fail(deps, purchaseId, state, "card:window-closed");
        return (await viewOf(deps.db, purchaseId)) as PurchaseView;
      }
    }

    if (state === "COUNTERSIGNED" || state === "LOGGED") {
      const logged =
        state === "COUNTERSIGNED" ? toLog() : Promise.resolve({ kind: "done" } as const);
      const covered = run(
        deps,
        purchaseId,
        "cover",
        () => coverStep(deps, purchaseId),
        row.countersignMode,
      );
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
    // A card purchase is captured by the merchant, through the card network: its card opens now.
    if (row.rail === "card") {
      const opened = await run(deps, purchaseId, "open", () => openCardStep(deps, purchaseId));
      if (opened.kind === "final") await fail(deps, purchaseId, "COVERED", opened.reason);
      else if (opened.kind === "done") {
        await publishPurchase(deps, purchaseId, { type: "purchase.card_open" });
        // Once the network settled the card's charge, it is collected from the PayPal hold.
        const collected = await run(deps, purchaseId, "capture", () =>
          captureCardStep(deps, purchaseId),
        );
        if (collected.kind === "final") await fail(deps, purchaseId, "COVERED", collected.reason);
      }
      return (await viewOf(deps.db, purchaseId)) as PurchaseView;
    }
    const capture = await run(
      deps,
      purchaseId,
      "capture",
      () => captureStep(deps, purchaseId),
      row.countersignMode,
    );
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
        // A live purchase has nothing left to drive once logged.
        or(isNull(purchases.liveStore), eq(purchases.state, "COUNTERSIGNED")),
        // Nor a card purchase whose open card waits for a charge; once the charge settled, its
        // collection from the PayPal hold is driven again.
        sql`not (${purchases.state} = 'COVERED' and exists (select 1 from purchase_cards pc where pc.purchase_id = ${purchases.id} and pc.state <> 'PAUSED' and pc.settled_minor is null))`,
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
        // A deny logged before its Alibi was issued is driven again: the append is idempotent.
        sql`not exists (select 1 from alibis a where a.purchase_id = ${purchases.id})`,
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
