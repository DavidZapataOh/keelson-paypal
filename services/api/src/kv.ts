import { createClient, type RedisClientType } from "redis";

export async function createKv(url: string): Promise<RedisClientType> {
  const client = createClient({ url }) as RedisClientType;
  client.on("error", () => {});
  await client.connect();
  return client;
}
