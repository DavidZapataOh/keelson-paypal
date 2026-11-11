import type { RedisClientType } from "redis";

/**
 * The key that holds, in unix seconds, when the user last stopped every agent or, with
 * `clientId`, last disconnected that app.
 */
export const stoppedKey = (userId: string, clientId?: string) =>
  clientId === undefined ? `agents-stopped:${userId}` : `agents-stopped:${userId}:${clientId}`;

/**
 * Whether an access token the user's consent issued to `clientId` at `iat` (unix seconds)
 * predates a stop of every agent or a disconnect of that app: such a token is refused, although
 * its signature still verifies. Rejects when the store cannot answer, and the caller refuses the
 * token then too.
 */
export async function tokenStopped(
  kv: RedisClientType,
  userId: string,
  clientId: string,
  iat: number | undefined,
): Promise<boolean> {
  const stops = await kv.mGet([stoppedKey(userId), stoppedKey(userId, clientId)]);
  return stops.some((at) => at !== null && (iat === undefined || iat <= Number(at)));
}
