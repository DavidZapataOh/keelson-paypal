import { createHash, randomBytes } from "node:crypto";
import type { RedisClientType } from "redis";
import { ulid } from "ulid";

/** How long an embed token may wait before the frame redeems it. */
export const EMBED_TOKEN_TTL_SEC = 300;

/** A request's embed: the request, the client that framed it and the one origin allowed to. */
export interface Embed {
  ref: string;
  connectionId: string;
  clientId: string;
  /** The agent platform's origin, the only `frame-ancestors` and `postMessage` peer. */
  origin: string;
}

const EMBED_REF = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const digest = (secret: string) => createHash("sha256").update(secret, "utf8").digest("hex");
const refKey = (ref: string) => `embed:ref:${ref}`;
const tokenKey = (token: string) => `embed:tok:${digest(token)}`;
const sessionKey = (session: string) => `embed:ses:${digest(session)}`;

/** An https origin with a DNS hostname: no wildcard, IP literal or CSP separator can pass. */
const ORIGIN =
  /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9](?::\d{1,5})?$/;

/**
 * A serialized https origin, or undefined: a DNS hostname and optional port, with no path,
 * query, fragment or credentials, as `URL.origin` writes it. Keelson's own hosts are refused.
 */
export function httpsOrigin(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.origin !== input || !ORIGIN.test(url.origin)) {
    return undefined;
  }
  if (url.hostname === "keelson.finance" || url.hostname.endsWith(".keelson.finance")) {
    return undefined;
  }
  return url.origin;
}

/**
 * Mints an embed for a pending request: a public `ref` the frame's URL carries, so the page can
 * name its one allowed ancestor, and a single-use `token` only the frame redeems. Both live until
 * the request can no longer be collected (`liveUntil`); the token, at most five minutes.
 */
export async function mintEmbed(
  kv: RedisClientType,
  input: Omit<Embed, "ref">,
  liveUntil: Date,
): Promise<{ ref: string; token: string }> {
  const ref = ulid();
  const token = `ket_${randomBytes(32).toString("base64url")}`;
  const ttl = Math.max(1, Math.ceil((liveUntil.getTime() - Date.now()) / 1000));
  await kv
    .multi()
    .set(refKey(ref), JSON.stringify({ ref, ...input } satisfies Embed), { EX: ttl })
    .set(tokenKey(token), ref, { EX: Math.min(ttl, EMBED_TOKEN_TTL_SEC) })
    .exec();
  return { ref, token };
}

/** The embed `ref` names, while its request can be collected. */
export async function readEmbed(kv: RedisClientType, ref: string): Promise<Embed | undefined> {
  if (!EMBED_REF.test(ref)) return undefined;
  const raw = await kv.get(refKey(ref));
  return raw ? (JSON.parse(raw) as Embed) : undefined;
}

/**
 * Spends an embed token for a session the frame keeps in memory. The token is deleted as it is
 * read, so a replay finds nothing.
 */
export async function redeemEmbed(
  kv: RedisClientType,
  token: string,
): Promise<{ embed: Embed; session: string } | undefined> {
  if (!token.startsWith("ket_") || token.length > 64) return undefined;
  const ref = await kv.getDel(tokenKey(token));
  if (!ref) return undefined;
  const embed = await readEmbed(kv, ref);
  const ttl = await kv.ttl(refKey(ref));
  if (!embed || ttl <= 0) return undefined;
  const session = `kes_${randomBytes(32).toString("base64url")}`;
  await kv.set(sessionKey(session), ref, { EX: ttl });
  return { embed, session };
}

/** The embed a frame's session belongs to. */
export async function sessionEmbed(
  kv: RedisClientType,
  session: string | undefined,
): Promise<Embed | undefined> {
  if (!session?.startsWith("kes_") || session.length > 64) return undefined;
  const ref = await kv.get(sessionKey(session));
  return ref ? readEmbed(kv, ref) : undefined;
}
