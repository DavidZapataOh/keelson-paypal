import { agentConnections, agentStops, type Db, sql } from "@keelson/db";

/**
 * Whether an access token the user's consent issued to `clientId` at `iat` (unix seconds)
 * predates the user's last stop of every agent (`agent_stops`) or the app's last disconnect
 * (`agent_connections.disconnected_at`): such a token is refused, although its signature still
 * verifies. Postgres holds both, so a revocation outlives any cache; when it cannot be read, this
 * rejects and the caller refuses the token.
 */
export async function tokenStopped(
  db: Pick<Db, "execute">,
  userId: string,
  clientId: string,
  iat: number | undefined,
): Promise<boolean> {
  const { rows } = await db.execute<{ at: string | null }>(sql`select extract(epoch from greatest(
      (select max(${agentStops.createdAt}) from ${agentStops} where ${agentStops.userId} = ${userId}),
      (select max(${agentConnections.disconnectedAt}) from ${agentConnections}
        where ${agentConnections.userId} = ${userId} and ${agentConnections.clientId} = ${clientId})
    ))::text as at`);
  const at = rows[0]?.at;
  return at !== null && at !== undefined && (iat === undefined || iat <= Number(at));
}
