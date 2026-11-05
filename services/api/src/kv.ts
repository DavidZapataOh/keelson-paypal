import type { Logger } from "pino";
import { createClient, type RedisClientType } from "redis";

/** Connects with the offline queue disabled so commands fail fast while the server is down. */
export async function createKv(url: string, log: Logger): Promise<RedisClientType> {
  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: { connectTimeout: 5_000 },
  }) as RedisClientType;
  client.on("error", (err) => log.warn({ err }, "valkey client error"));
  await client.connect();
  return client;
}
