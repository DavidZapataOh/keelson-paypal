import {
  agentConnections,
  type Db,
  eq,
  mandates,
  oauthClient,
  openPurchase,
  operators,
  purchaseHolds,
  purchases,
  type SQL,
  sql,
} from "@keelson/db";
import { money } from "./notify/notifier.ts";

/**
 * The redirect URIs the MCP hosts Keelson knows register (RFC 7591), each from the host's own
 * documentation. A redirect URI says where codes go, not who registered, so an app whose every
 * redirect URI is one of these is still capped; it gets the higher tier (see {@link HostedCaps}).
 * A loopback URI (RFC 8252 §7.3) is never known: any local app can register one.
 */
export const KNOWN_REDIRECT_URIS: readonly string[] = [
  // Claude (claude.ai, Claude Desktop)
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  // ChatGPT
  "https://chatgpt.com/connector_platform_oauth_redirect",
  // Cursor
  "cursor://anysphere.cursor-mcp/oauth/callback",
  "https://www.cursor.com/agents/mcp/oauth/callback",
];

/** The one currency an app acting through the hosted operator may ask for, so the caps add up. */
export const HOSTED_CAP_CURRENCY = "USD";

/** A signed mandate whose hold has not completed by then expires, and stops counting. */
export const FUNDING_TTL_MS = 30 * 60_000;

/**
 * A captured purchase counts until a buyer can no longer dispute it: PayPal Purchase Protection
 * takes a dispute within 180 days of the payment.
 */
export const DISPUTE_WINDOW_DAYS = 180;

/**
 * What Keelson's hosted bond backs for apps that registered themselves (RFC 7591) and act through
 * its hosted operator, in minor units of {@link HOSTED_CAP_CURRENCY}. Exposure is what live
 * mandates have left plus what was captured under them within {@link DISPUTE_WINDOW_DAYS}.
 */
export interface HostedCaps {
  /** Most one user's exposure to apps whose redirect URIs are not a known host's may reach. */
  perUserMinor: bigint;
  /** Most one user's exposure to every such app, known hosts included, may reach. */
  knownPerUserMinor: bigint;
  /** Most every user's funded exposure (holds completed or, while funding, in flight) may reach. */
  totalMinor: bigint;
}

/** `known`: every redirect URI is a known host's; `unknown`: any other self-registered app. */
export type HostTier = "known" | "unknown";

/** Whether every redirect URI the app registered is a known host's. */
export function knownHost(redirectUris: readonly string[]): boolean {
  return redirectUris.length > 0 && redirectUris.every((u) => KNOWN_REDIRECT_URIS.includes(u));
}

/** The cap tier of `clientId` acting through the hosted operator; none for its own client. */
export async function hostTier(
  db: Pick<Db, "select">,
  clientId: string,
  hostedClientId: string | null,
): Promise<HostTier | undefined> {
  if (clientId === hostedClientId) return undefined;
  const [client] = await db
    .select({ redirectUris: oauthClient.redirectUris })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId));
  return client && knownHost(client.redirectUris) ? "known" : "unknown";
}

/** The most one user's exposure to apps of `tier` may reach. */
export const tierCap = (caps: HostedCaps, tier: HostTier) =>
  tier === "known" ? caps.knownPerUserMinor : caps.perUserMinor;

const knownSql = sql`array[${sql.join(
  KNOWN_REDIRECT_URIS.map((u) => sql`${u}`),
  sql`, `,
)}]::text[]`;

interface Scope {
  hostedAgentId: bigint;
  hostedClientId: string | null;
  currency?: string;
  /** One user's exposure; all users' without it. */
  userId?: string;
  /** Only apps whose redirect URIs are not a known host's. */
  unknownOnly?: boolean;
  /** Left out of what live mandates have left: a change replaces it. */
  replaces?: string | null;
}

/** Whether the row of `mandates` is the hosted operator's, approved for an app in `scope`. */
function cappedMandate(scope: Scope): SQL {
  const unknown = scope.unknownOnly
    ? sql`and (${oauthClient.redirectUris} is null
        or cardinality(${oauthClient.redirectUris}) = 0
        or exists (select 1 from unnest(${oauthClient.redirectUris}) as u(uri)
          where not u.uri = any(${knownSql})))`
    : sql``;
  return sql`${mandates.operatorAgentId} = ${scope.hostedAgentId}
    ${scope.currency === undefined ? sql`` : sql`and ${mandates.currency} = ${scope.currency}`}
    ${scope.userId === undefined ? sql`` : sql`and ${mandates.userId} = ${scope.userId}`}
    and exists (
      select 1 from ${agentConnections}
      left join ${oauthClient} on ${oauthClient.clientId} = ${agentConnections.clientId}
      where ${agentConnections.mandateId} = ${mandates.id}
        and ${agentConnections.state} = 'APPROVED'
        and ${agentConnections.clientId} is distinct from ${scope.hostedClientId}
        ${unknown})`;
}

/**
 * The exposure of `scope`. Without `funded`, every live mandate counts what it has left: what the
 * user has granted. With `funded`, only money held does: whole-budget holds completed, and cart
 * holds authorized; with `inFlight` too, holds a buyer is still approving. Purchases captured
 * within {@link DISPUTE_WINDOW_DAYS} always count, so spending a mandate and asking for another
 * cannot pass a cap.
 */
export async function hostedExposure(
  db: Pick<Db, "execute">,
  scope: Scope,
  mode: { funded?: boolean; inFlight?: boolean } = {},
): Promise<bigint> {
  const capped = cappedMandate(scope);
  const replaced = scope.replaces ? sql`and ${mandates.id} <> ${scope.replaces}` : sql``;
  const live = mode.funded
    ? sql`${mandates.holdMode} = 'mandate' and ${mandates.state} in ${mode.inFlight ? sql`('HOLD_PENDING', 'ACTIVE')` : sql`('ACTIVE')`}`
    : sql`${mandates.state} in ('SIGNED', 'HOLD_PENDING', 'ACTIVE')`;
  const holds = mode.funded
    ? sql`(select coalesce(sum(${purchaseHolds.amountMinor}), 0) from ${purchaseHolds}
        join ${mandates} on ${mandates.id} = ${purchaseHolds.mandateId}
        where ${capped} and ${mandates.holdMode} = 'per_purchase'
          and ${purchaseHolds.state} in ${mode.inFlight ? sql`('PENDING', 'AUTHORIZED')` : sql`('AUTHORIZED')`})`
    : sql`0`;
  const { rows } = await db.execute<{ exposure: string }>(sql`select (
      (select coalesce(sum(${mandates.remainingMinor}), 0) from ${mandates}
        where ${capped} and ${live} and ${mandates.revokeRequestedAt} is null ${replaced})
      + ${holds}
      + (select coalesce(sum(${purchases.amountMinor}), 0) from ${purchases}
        join ${mandates} on ${mandates.id} = ${purchases.mandateId}
        where ${capped}
          and ${purchases.capturedAt} > now() - make_interval(days => ${DISPUTE_WINDOW_DAYS})
          and ${openPurchase(purchases.state)})
    )::text as exposure`);
  return BigInt(rows[0]?.exposure ?? "0");
}

/** Serializes the cap checks of concurrent approvals and holds until the transaction ends. */
export const lockHostedExposure = (tx: Pick<Db, "execute">) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext('keelson.hosted-exposure'))`);

/** The sentence an app or the user reads when a per-user cap stops a mandate. */
const userCapMessage = (tier: HostTier, limit: bigint, currency: string) =>
  `Keelson's hosted operator backs at most ${money(limit, currency)} per user, across open mandates and purchases of the last ${DISPUTE_WINDOW_DAYS} days, for ${tier === "known" ? "apps acting through it" : "apps it does not know"}. Lower the total, or end another mandate first.`;

const TOTAL_CAP_MESSAGE =
  "Keelson's hosted operator has reached what it backs for apps acting through it. Try again later, or connect an app with an operator of its own.";

/** The hosted operator's own OAuth client, which the caps never bound. */
export async function hostedClientId(
  db: Pick<Db, "select">,
  hostedAgentId: bigint,
): Promise<string | null> {
  const [row] = await db
    .select({ clientId: operators.clientId })
    .from(operators)
    .where(eq(operators.agentId, hostedAgentId));
  return row?.clientId ?? null;
}

type CapDeps = { demoAgentId?: bigint | undefined; hostedCaps?: HostedCaps | undefined };

/**
 * Why a mandate of `amountMinor` for `clientId` would pass a cap, or nothing when no cap applies
 * or none would be passed. Per user, what is granted counts, funded or not; in total, only what is
 * funded. With `lock`, `db` is the transaction that stores the mandate and concurrent approvals
 * wait for it, so the cap holds.
 */
export async function hostedCapError(
  db: Pick<Db, "select" | "execute">,
  deps: CapDeps,
  input: {
    clientId: string;
    operatorAgentId: bigint;
    userId: string;
    currency: string;
    amountMinor: bigint;
    replaces?: string | null;
  },
  lock = false,
): Promise<string | undefined> {
  const { hostedCaps: caps, demoAgentId } = deps;
  if (!caps || demoAgentId === undefined || input.operatorAgentId !== demoAgentId) return;
  const hosted = await hostedClientId(db, demoAgentId);
  const tier = await hostTier(db, input.clientId, hosted);
  if (!tier) return;
  if (input.currency !== HOSTED_CAP_CURRENCY) {
    return `Keelson's hosted operator backs apps acting through it in ${HOSTED_CAP_CURRENCY} only.`;
  }
  if (lock) await lockHostedExposure(db);
  const scope: Scope = {
    hostedAgentId: demoAgentId,
    hostedClientId: hosted,
    currency: input.currency,
    userId: input.userId,
    replaces: input.replaces ?? null,
  };
  if (tier === "unknown") {
    const unknown = await hostedExposure(db, { ...scope, unknownOnly: true });
    if (unknown + input.amountMinor > caps.perUserMinor) {
      return userCapMessage("unknown", caps.perUserMinor, input.currency);
    }
  }
  if ((await hostedExposure(db, scope)) + input.amountMinor > caps.knownPerUserMinor) {
    return userCapMessage("known", caps.knownPerUserMinor, input.currency);
  }
  const { userId: _, ...all } = scope;
  if ((await hostedExposure(db, all, { funded: true })) + input.amountMinor > caps.totalMinor) {
    return TOTAL_CAP_MESSAGE;
  }
  return undefined;
}

/**
 * Why holding `amountMinor` for mandate `mandateId` would pass the total cap, or nothing. Call it
 * in the transaction that records the hold, which then waits for concurrent ones: what they hold,
 * completed or in flight, counts.
 */
export async function fundingCapError(
  tx: Pick<Db, "select" | "execute">,
  deps: CapDeps,
  mandateId: string,
  amountMinor: bigint,
): Promise<string | undefined> {
  const { hostedCaps: caps, demoAgentId } = deps;
  if (!caps || demoAgentId === undefined) return;
  const hosted = await hostedClientId(tx, demoAgentId);
  const scope: Scope = { hostedAgentId: demoAgentId, hostedClientId: hosted };
  const [row] = await tx
    .select({ capped: sql<boolean>`${cappedMandate(scope)}` })
    .from(mandates)
    .where(eq(mandates.id, mandateId));
  if (!row?.capped) return;
  await lockHostedExposure(tx);
  const funded = await hostedExposure(
    tx,
    { ...scope, currency: HOSTED_CAP_CURRENCY },
    { funded: true, inFlight: true },
  );
  return funded + amountMinor > caps.totalMinor ? TOTAL_CAP_MESSAGE : undefined;
}

/**
 * Expires the mandates of apps acting through the hosted operator that were signed more than
 * {@link FUNDING_TTL_MS} ago and hold nothing yet, and voids their cart holds a buyer never
 * approved, so neither counts against a cap any more. An authorization PayPal already returned
 * (pending) is left to finish. Returns how many rows ended.
 */
export async function expireUnfunded(
  db: Pick<Db, "execute">,
  hostedAgentId: bigint,
  now: Date = new Date(),
): Promise<number> {
  const hosted = sql`(select ${operators.clientId} from ${operators} where ${operators.agentId} = ${hostedAgentId})`;
  const ofApp = sql`${mandates.operatorAgentId} = ${hostedAgentId} and exists (
      select 1 from ${agentConnections}
      where ${agentConnections.mandateId} = ${mandates.id}
        and ${agentConnections.state} = 'APPROVED'
        and ${agentConnections.clientId} is distinct from ${hosted})`;
  const before = new Date(now.getTime() - FUNDING_TTL_MS);
  const expired = await db.execute(sql`update ${mandates}
    set state = 'EXPIRED', updated_at = now()
    where ${ofApp} and ${mandates.state} in ('SIGNED', 'HOLD_PENDING')
      and ${mandates.paypalParentAuthorizationId} is null
      and ${mandates.createdAt} < ${before}`);
  const voided = await db.execute(sql`update ${purchaseHolds}
    set state = 'VOIDED', updated_at = now()
    from ${mandates}
    where ${mandates.id} = ${purchaseHolds.mandateId} and ${ofApp}
      and ${purchaseHolds.state} = 'PENDING'
      and ${purchaseHolds.paypalAuthorizationId} is null
      and ${purchaseHolds.createdAt} < ${before}`);
  return (expired.rowCount ?? 0) + (voided.rowCount ?? 0);
}

/** Expires unfunded mandates of apps acting through the hosted operator every minute. */
export function startUnfundedExpiry(deps: {
  db: Db;
  hostedAgentId: bigint;
  log: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
}): () => void {
  const timer = setInterval(() => {
    expireUnfunded(deps.db, deps.hostedAgentId).then(
      (count) => {
        if (count > 0) deps.log.warn({ count }, "unfunded hosted mandates expired");
      },
      (err: unknown) => deps.log.error({ err }, "unfunded expiry failed"),
    );
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
