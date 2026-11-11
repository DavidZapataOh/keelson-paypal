import {
  agentConnections,
  and,
  type Db,
  eq,
  mandates,
  oauthClient,
  operators,
  sql,
} from "@keelson/db";
import { money } from "./notify/notifier.ts";
import { REVOCABLE } from "./routes/revoke.ts";

/**
 * The redirect URIs the MCP hosts Keelson knows register (RFC 7591), each from the host's own
 * documentation. An app whose every redirect URI is one of these gets the standard limits through
 * Keelson's hosted operator; any other self-registered app is capped (see {@link HostedCaps}).
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

/**
 * Claude Code (and Cursor's desktop app) redirect to a loopback port it picks (RFC 8252 §7.3).
 * Any local app can register such a URI, so it identifies a native app, not which one.
 */
const LOOPBACK = "^http://(localhost|127\\.0\\.0\\.1):[0-9]{1,5}/callback$";

/**
 * Limits on what Keelson's hosted bond backs for apps it does not know, in minor units of the
 * mandate's currency, counted per currency over live mandates (what is left of each).
 */
export interface HostedCaps {
  /** Most one user's live mandates for such apps may have left, together. */
  perUserMinor: bigint;
  /** Most every user's live mandates for such apps may have left, together. */
  totalMinor: bigint;
}

/** Whether every redirect URI the app registered is a known host's. */
export function knownHost(redirectUris: readonly string[]): boolean {
  const loopback = new RegExp(LOOPBACK);
  return (
    redirectUris.length > 0 &&
    redirectUris.every((u) => KNOWN_REDIRECT_URIS.includes(u) || loopback.test(u))
  );
}

/**
 * Whether `clientId` is an app acting through the hosted operator that the caps bound: any client
 * but the hosted operator's own whose registration is missing or names a redirect URI no known
 * host registers.
 */
export async function cappedHost(
  db: Pick<Db, "select">,
  clientId: string,
  hostedClientId: string | null,
): Promise<boolean> {
  if (clientId === hostedClientId) return false;
  const [client] = await db
    .select({ redirectUris: oauthClient.redirectUris })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId));
  return !client || !knownHost(client.redirectUris);
}

const knownSql = sql`array[${sql.join(
  KNOWN_REDIRECT_URIS.map((u) => sql`${u}`),
  sql`, `,
)}]::text[]`;

/**
 * What the user's (or, without `userId`, every user's) live mandates of the hosted operator that a
 * capped app holds have left, in `currency`. `replaces` is left out: a change replaces it.
 */
export async function hostedExposure(
  db: Pick<Db, "select">,
  input: {
    hostedAgentId: bigint;
    hostedClientId: string | null;
    currency: string;
    userId?: string;
    replaces?: string | null;
  },
): Promise<bigint> {
  const capped = sql`exists (
    select 1 from ${agentConnections}
    left join ${oauthClient} on ${oauthClient.clientId} = ${agentConnections.clientId}
    where ${agentConnections.mandateId} = ${mandates.id}
      and ${agentConnections.state} = 'APPROVED'
      and ${agentConnections.clientId} is distinct from ${input.hostedClientId}
      and (${oauthClient.redirectUris} is null
        or cardinality(${oauthClient.redirectUris}) = 0
        or exists (select 1 from unnest(${oauthClient.redirectUris}) as u(uri)
          where not (u.uri = any(${knownSql}) or u.uri ~ ${LOOPBACK}))))`;
  const [row] = await db
    .select({ left: sql<string>`coalesce(sum(${mandates.remainingMinor}), 0)::text` })
    .from(mandates)
    .where(
      and(
        eq(mandates.operatorAgentId, input.hostedAgentId),
        eq(mandates.currency, input.currency),
        sql`${mandates.state} in (${sql.join(
          REVOCABLE.map((s) => sql`${s}`),
          sql`, `,
        )})`,
        sql`${mandates.revokeRequestedAt} is null`,
        input.userId === undefined ? undefined : eq(mandates.userId, input.userId),
        input.replaces ? sql`${mandates.id} <> ${input.replaces}` : undefined,
        capped,
      ),
    );
  return BigInt(row?.left ?? "0");
}

/**
 * Which cap a new mandate of `amountMinor` for a capped app would pass, if any. Call it inside the
 * transaction that stores the mandate, after {@link lockHostedExposure}, for the cap to hold.
 */
export async function overHostedCap(
  db: Pick<Db, "select">,
  caps: HostedCaps,
  input: {
    hostedAgentId: bigint;
    hostedClientId: string | null;
    userId: string;
    currency: string;
    amountMinor: bigint;
    replaces?: string | null;
  },
): Promise<"user" | "total" | undefined> {
  const { userId, ...all } = input;
  if ((await hostedExposure(db, { ...all, userId })) + input.amountMinor > caps.perUserMinor) {
    return "user";
  }
  if ((await hostedExposure(db, all)) + input.amountMinor > caps.totalMinor) return "total";
  return undefined;
}

/** Serializes the cap checks of concurrent approvals until the transaction ends. */
export const lockHostedExposure = (tx: Pick<Db, "execute">) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext('keelson.hosted-exposure'))`);

/** The sentence an app or the user reads when a cap stops a mandate. */
export const capMessage = (which: "user" | "total", caps: HostedCaps, currency: string) =>
  which === "user"
    ? `Keelson's hosted operator backs at most ${money(caps.perUserMinor, currency)} of open mandates per user for an app it does not know. Lower the total, or end another mandate first.`
    : "Keelson's hosted operator has reached what it backs for apps it does not know. Try again later, or connect an app with an operator of its own.";

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

/**
 * Why a mandate of `amountMinor` for `clientId` would pass a cap, or nothing when no cap applies
 * or none would be passed. With `lock`, `db` is the transaction that stores the mandate and
 * concurrent approvals wait for it, so the cap holds.
 */
export async function hostedCapError(
  db: Pick<Db, "select" | "execute">,
  deps: { demoAgentId?: bigint | undefined; hostedCaps?: HostedCaps | undefined },
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
  if (!(await cappedHost(db, input.clientId, hosted))) return;
  if (lock) await lockHostedExposure(db);
  const over = await overHostedCap(db, caps, {
    hostedAgentId: demoAgentId,
    hostedClientId: hosted,
    userId: input.userId,
    currency: input.currency,
    amountMinor: input.amountMinor,
    replaces: input.replaces ?? null,
  });
  return over && capMessage(over, caps, input.currency);
}
