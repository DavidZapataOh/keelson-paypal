import { createHash, randomBytes } from "node:crypto";
import { type Db, embedOrigins, eq } from "@keelson/db";
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
  /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9](?::[1-9]\d{0,4})?$/;

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

/** How long a passkey ceremony the frame started may wait for its answer. */
const EMBED_CEREMONY_TTL_SEC = 300;
/** How long a grant the Keelson window hands the frame may wait to be claimed. */
export const EMBED_GRANT_TTL_SEC = EMBED_CEREMONY_TTL_SEC;
/** How long a link the frame opened in a Keelson window may wait for the user. */
export const EMBED_LINK_TTL_SEC = 600;

const userKey = (sessionDigest: string) => `embed:usr:${sessionDigest}`;
const ceremonyKey = (session: string) => `embed:cer:${digest(session)}`;
const linkKey = (nonce: string) => `embed:lnk:${digest(nonce)}`;
const grantKey = (grant: string) => `embed:grt:${digest(grant)}`;

/** Who a frame's session signs for, once a passkey or a Keelson window said so. */
export interface EmbedUser {
  userId: string;
  /** The passkey the user signed in with in the frame, so present on this device. */
  credentialId?: string;
  /** Linked from a Keelson window for a user with no passkey: the frame may create one. */
  mayCreate?: boolean;
}

/** A WebAuthn ceremony the frame started, answered once. */
export interface EmbedCeremony {
  kind: "authenticate" | "register";
  challenge: string;
  /** For a registration: the `payment` extension was requested, so SPC may use the passkey. */
  payment?: boolean;
}

/** The user a frame's session is bound to. */
export async function sessionUser(
  kv: RedisClientType,
  session: string,
): Promise<EmbedUser | undefined> {
  const raw = await kv.get(userKey(digest(session)));
  return raw ? (JSON.parse(raw) as EmbedUser) : undefined;
}

/** Binds the session to `user` for as long as the session lives. */
export async function bindUser(
  kv: RedisClientType,
  session: string,
  user: EmbedUser,
): Promise<void> {
  const ttl = await kv.ttl(sessionKey(session));
  if (ttl <= 0) return;
  await kv.set(userKey(digest(session)), JSON.stringify(user), { EX: ttl });
}

/** Starts a ceremony for the session, replacing any it had. */
export async function startCeremony(
  kv: RedisClientType,
  session: string,
  ceremony: EmbedCeremony,
): Promise<void> {
  await kv.set(ceremonyKey(session), JSON.stringify(ceremony), { EX: EMBED_CEREMONY_TTL_SEC });
}

/** The session's ceremony, deleted as it is read, so an answer is checked against it once. */
export async function takeCeremony(
  kv: RedisClientType,
  session: string,
): Promise<EmbedCeremony | undefined> {
  const raw = await kv.getDel(ceremonyKey(session));
  return raw ? (JSON.parse(raw) as EmbedCeremony) : undefined;
}

/**
 * A single-use nonce for the Keelson window the frame opens. The user who signs in there and
 * confirms gets a grant for this session; the frame alone receives it, from that window.
 */
export async function mintLink(kv: RedisClientType, session: string): Promise<string> {
  const nonce = `kel_${randomBytes(32).toString("base64url")}`;
  await kv.set(linkKey(nonce), digest(session), { EX: EMBED_LINK_TTL_SEC });
  return nonce;
}

/** The embed a link was minted for, while it is unspent. */
export async function linkEmbed(kv: RedisClientType, nonce: string): Promise<Embed | undefined> {
  if (!nonce.startsWith("kel_") || nonce.length > 64) return undefined;
  const sessionDigest = await kv.get(linkKey(nonce));
  const ref = sessionDigest ? await kv.get(`embed:ses:${sessionDigest}`) : null;
  return ref ? readEmbed(kv, ref) : undefined;
}

/**
 * Spends a link for `userId`, returning a single-use grant that binds the link's session to
 * them once that session claims it. `mayCreate` says whether the frame may create their passkey.
 */
export async function confirmLink(
  kv: RedisClientType,
  nonce: string,
  user: { userId: string; mayCreate: boolean },
): Promise<{ embed: Embed; grant: string } | undefined> {
  const embed = await linkEmbed(kv, nonce);
  const sessionDigest = embed ? await kv.getDel(linkKey(nonce)) : null;
  if (!embed || !sessionDigest) return undefined;
  const grant = `keg_${randomBytes(32).toString("base64url")}`;
  await kv.set(grantKey(grant), JSON.stringify({ sessionDigest, ...user }), {
    EX: EMBED_CEREMONY_TTL_SEC,
  });
  return { embed, grant };
}

/** Binds `session` to the user a grant names, if the grant was made for this session. */
export async function claimGrant(
  kv: RedisClientType,
  session: string,
  grant: string,
): Promise<EmbedUser | undefined> {
  if (!grant.startsWith("keg_") || grant.length > 64) return undefined;
  const raw = await kv.getDel(grantKey(grant));
  const g = raw
    ? (JSON.parse(raw) as { sessionDigest: string; userId: string; mayCreate: boolean })
    : undefined;
  if (!g || g.sessionDigest !== digest(session)) return undefined;
  const user: EmbedUser = { userId: g.userId, mayCreate: g.mayCreate };
  await bindUser(kv, session, user);
  return user;
}

/** The https origins `clientId` registered for embedding. */
export async function clientEmbedOrigins(db: Db, clientId: string): Promise<string[]> {
  const rows = await db
    .select({ origin: embedOrigins.origin })
    .from(embedOrigins)
    .where(eq(embedOrigins.clientId, clientId));
  return rows.map((r) => r.origin);
}
