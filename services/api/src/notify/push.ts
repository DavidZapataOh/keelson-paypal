import { createHash } from "node:crypto";
import { type Db, eq, pushSubscriptions } from "@keelson/db";
import type { Logger } from "pino";
import { sendNotification, WebPushError } from "web-push";

/** The application server's VAPID key pair and contact (RFC 8292). */
export interface Vapid {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/** What the service worker shows, and the page a tap opens. */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  /** Replaces an earlier notification with the same tag. */
  tag: string;
}

/**
 * The RFC 8030 §5.4 topic of every push about `subject`: a newer one replaces an older one the
 * push service still holds. At most 32 URL-safe base64 characters.
 */
export function pushTopic(subject: string): string {
  return createHash("sha256").update(subject).digest("base64url").slice(0, 32);
}

/**
 * The payload as a Declarative Web Push message, which Safari shows with no service worker code;
 * the service worker shows the same `notification` elsewhere.
 * @see https://webkit.org/blog/16535/meet-declarative-web-push/
 */
export function declarativePush(payload: PushPayload, silent = false) {
  return {
    web_push: 8030,
    notification: {
      title: payload.title,
      body: payload.body,
      navigate: payload.url,
      tag: payload.tag,
      lang: "en",
      dir: "ltr",
      silent,
    },
  } as const;
}

/**
 * Sends the payload to every browser the user subscribed, encrypted to each (RFC 8291). A
 * subscription the push service no longer knows (404, 410) is deleted. Resolves to how many push
 * services accepted it.
 */
export async function sendPush(
  deps: { db: Db; log: Logger; vapid: Vapid },
  userId: string,
  payload: PushPayload,
  options: { ttl: number; urgency: "low" | "normal" | "high"; topic?: string | undefined },
): Promise<number> {
  const subs = await deps.db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));
  const sent = await Promise.all(
    subs.map(async (s) => {
      try {
        await sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(declarativePush(payload, options.urgency === "low")),
          {
            vapidDetails: deps.vapid,
            TTL: options.ttl,
            urgency: options.urgency,
            ...(options.topic === undefined ? {} : { topic: options.topic }),
            timeout: 10_000,
          },
        );
        return 1;
      } catch (err) {
        if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
          await deps.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
        } else {
          deps.log.warn({ err, subscriptionId: s.id }, "push not delivered");
        }
        return 0;
      }
    }),
  );
  return sent.reduce<number>((a, b) => a + b, 0);
}
