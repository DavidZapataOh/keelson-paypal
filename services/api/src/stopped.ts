import type { RedisClientType } from "redis";

/** The key that holds when the user last stopped every agent, in unix seconds. */
export const stoppedKey = (userId: string) => `agents-stopped:${userId}`;

/**
 * Whether an access token the user's consent issued at `iat` (unix seconds) predates a stop of
 * every agent: such a token is refused, although its signature still verifies.
 */
export async function tokenStopped(
  kv: RedisClientType,
  userId: string,
  iat: number | undefined,
): Promise<boolean> {
  const at = await kv.get(stoppedKey(userId)).catch(() => null);
  return at !== null && (iat === undefined || iat <= Number(at));
}
