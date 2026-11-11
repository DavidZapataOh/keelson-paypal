import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { type Db, eq, sentEmails } from "@keelson/db";
import type { Logger } from "pino";
import type { Resend } from "resend";
import { ulid } from "ulid";

/** Every alert comes from one verified sender. */
const FROM = "Keelson <notify@keelson.finance>";

/** How long a confirmation link works, in seconds. */
export const CONFIRM_TTL_SEC = 86_400;

export type LinkClaims =
  /** Confirms `address` for the user; works once, until `exp`. */
  | { p: "confirm"; u: string; n: string; exp: number }
  /** Stops the alerts sent to the address whose hash is `a`. */
  | { p: "unsubscribe"; u: string; a: string };

const key = (secret: string) =>
  Buffer.from(hkdfSync("sha256", secret, "", "keelson.finance/alert-links/v1", 32));

/** A hash of the address, so an unsubscribe link names no address. */
export const addressHash = (address: string): string =>
  createHash("sha256").update(address.toLowerCase(), "utf8").digest("base64url").slice(0, 22);

/** `<claims>.<HMAC-SHA256>`, both base64url. */
export function signLink(secret: string, claims: LinkClaims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const mac = createHmac("sha256", key(secret)).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/** The claims of a link this server signed and that has not expired. */
export function verifyLink(secret: string, token: string): LinkClaims | undefined {
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return undefined;
  const want = createHmac("sha256", key(secret)).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as LinkClaims;
    if (claims.p === "confirm" && claims.exp * 1000 <= Date.now()) return undefined;
    return claims;
  } catch {
    return undefined;
  }
}

/** One composed email: what it says and what it reports. */
export interface Email {
  event: string;
  subject: string;
  text: string;
  html: string;
  subjectId?: string | null;
  logIndex?: bigint | null;
  alibiUrl?: string | null;
}

/**
 * Stores the email in the user's trail, then sends it through Resend with RFC 8058 one-click
 * unsubscribe headers. Without Resend it stays stored and unsent.
 */
export async function sendEmail(
  deps: { db: Db; log: Logger; resend?: Resend | undefined },
  to: { userId: string; address: string; unsubscribeUrl: string },
  email: Email,
): Promise<typeof sentEmails.$inferSelect> {
  const [row] = await deps.db
    .insert(sentEmails)
    .values({
      id: ulid(),
      userId: to.userId,
      address: to.address,
      event: email.event,
      subject: email.subject,
      subjectId: email.subjectId ?? null,
      logIndex: email.logIndex ?? null,
      alibiUrl: email.alibiUrl ?? null,
    })
    .returning();
  if (!row) throw new Error("the email was not stored");
  if (!deps.resend) return row;
  const { data, error } = await deps.resend.emails.send(
    {
      from: FROM,
      to: [to.address],
      subject: email.subject,
      text: email.text,
      html: email.html,
      headers: {
        "List-Unsubscribe": `<${to.unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    },
    { idempotencyKey: `email/${row.id}` },
  );
  const [done] = await deps.db
    .update(sentEmails)
    .set(
      error
        ? { error: `${error.name}: ${error.message}` }
        : { sentAt: new Date(), providerId: data?.id ?? null },
    )
    .where(eq(sentEmails.id, row.id))
    .returning();
  if (error) deps.log.warn({ error, emailId: row.id }, "email not sent");
  return done ?? row;
}
