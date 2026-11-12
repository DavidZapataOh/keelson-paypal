import {
  agentConnections,
  alertEmails,
  and,
  type Db,
  eq,
  isNotNull,
  mandates,
  purchases,
} from "@keelson/db";
import type { Logger } from "pino";
import type { Resend } from "resend";
import { agentName } from "../connections.ts";
import { MERCHANTS } from "../merchants.ts";
import type { StopRecord } from "../stop.ts";
import { addressHash, type Email, sendEmail, signLink } from "./email.ts";
import { pushTopic, sendPush, type Vapid } from "./push.ts";

/** Where alerts go out from and what they link to. Push needs `vapid`; email needs `resend`. */
export interface Notifier {
  db: Db;
  log: Logger;
  appOrigin: string;
  /** This API's public origin: RFC 8058 unsubscribes are posted to it. */
  apiOrigin: string;
  verifyOrigin: string;
  /** Signs the confirmation and unsubscribe links. */
  secret: string;
  vapid?: Vapid | undefined;
  resend?: Resend | undefined;
}

/** What one event tells the user, as a push and as an email. */
export interface Alert {
  event: string;
  title: string;
  body: string;
  /** The page a tap or the email's button opens. */
  url: string;
  action: string;
  details?: { label: string; value: string; href?: string }[];
  /** Null for email only. */
  push: { ttl: number; urgency: "low" | "normal" | "high" } | null;
  /** Sent as a push only: it replaces the push about the same subject, and is never mailed. */
  pushOnly?: boolean;
  subjectId?: string;
  logIndex?: bigint | null;
  alibiUrl?: string | null;
}

/** Minor units as money in the currency's own digits, e.g. `9400` USD → `$94.00`. */
export function money(minor: bigint | string, currency: string): string {
  const f = new Intl.NumberFormat("en-US", { style: "currency", currency });
  const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
  return f.format(Number(BigInt(minor)) / 10 ** digits);
}

const storeName = (id: string) => MERCHANTS.find((m) => m.id === id)?.name ?? id;

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );

/** The alert as an email: plain text and a small HTML version, both with the unsubscribe link. */
export function composeEmail(alert: Alert, unsubscribePage: string): Email {
  const details = alert.details ?? [];
  const text = [
    alert.title,
    "",
    alert.body,
    "",
    ...details.map((d) => `${d.label}: ${d.value}${d.href ? ` (${d.href})` : ""}`),
    ...(details.length ? [""] : []),
    `${alert.action}: ${alert.url}`,
    "",
    "You get this because you turned on email alerts in Keelson.",
    `Unsubscribe: ${unsubscribePage}`,
  ].join("\n");
  const rows = details
    .map(
      (d) =>
        `<tr><td style="padding:6px 16px 6px 0;color:#6b6a66">${escapeHtml(d.label)}</td><td style="padding:6px 0;font-family:ui-monospace,Menlo,monospace">${d.href ? `<a href="${escapeHtml(d.href)}" style="color:#17181b">${escapeHtml(d.value)}</a>` : escape(d.value)}</td></tr>`,
    )
    .join("");
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#f2f0ea;color:#17181b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"><div style="max-width:520px;margin:0 auto;padding:32px 24px"><p style="margin:0;font:600 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:#6b6a66">Keelson</p><h1 style="margin:20px 0 8px;font-size:22px;line-height:1.25">${escapeHtml(alert.title)}</h1><p style="margin:0 0 20px;font-size:16px;line-height:1.5">${escapeHtml(alert.body)}</p>${rows ? `<table style="margin:0 0 20px;font-size:14px;border-collapse:collapse">${rows}</table>` : ""}<p style="margin:0 0 32px"><a href="${escapeHtml(alert.url)}" style="display:inline-block;padding:12px 18px;border-radius:12px;background:#17181b;color:#f2f0ea;font-weight:600;text-decoration:none">${escapeHtml(alert.action)}</a></p><p style="margin:0;font-size:12px;line-height:1.5;color:#6b6a66">You get this because you turned on email alerts in Keelson. <a href="${escapeHtml(unsubscribePage)}" style="color:#6b6a66">Unsubscribe</a>.</p></div></body></html>`;
  return {
    event: alert.event,
    subject: alert.title,
    text,
    html,
    subjectId: alert.subjectId ?? null,
    logIndex: alert.logIndex ?? null,
    alibiUrl: alert.alibiUrl ?? null,
  };
}

/** The RFC 8058 one-click URL and the page the email's own link opens, for this address. */
export function unsubscribeLinks(n: Notifier, userId: string, address: string) {
  const token = signLink(n.secret, { p: "unsubscribe", u: userId, a: addressHash(address) });
  return {
    oneClick: `${n.apiOrigin}/v1/alerts/unsubscribe?token=${token}`,
    page: `${n.appOrigin}/alerts/unsubscribe/?token=${token}`,
  };
}

/**
 * Sends the alert as a push to the user's browsers and as an email to their confirmed address.
 * @internal
 */
export async function deliver(n: Notifier, userId: string, alert: Alert): Promise<void> {
  const pushed =
    alert.push && n.vapid
      ? sendPush(
          { db: n.db, log: n.log, vapid: n.vapid },
          userId,
          // One notification per subject: a newer push about it replaces the older one, shown or not.
          {
            title: alert.title,
            body: alert.body,
            url: alert.url,
            tag: alert.subjectId ?? alert.event,
          },
          {
            ...alert.push,
            topic: alert.subjectId === undefined ? undefined : pushTopic(alert.subjectId),
          },
        )
      : Promise.resolve(0);
  if (alert.pushOnly) {
    await pushed;
    return;
  }
  const [to] = await n.db
    .select({ address: alertEmails.address })
    .from(alertEmails)
    .where(and(eq(alertEmails.userId, userId), isNotNull(alertEmails.confirmedAt)));
  if (to) {
    const links = unsubscribeLinks(n, userId, to.address);
    await sendEmail(
      n,
      { userId, address: to.address, unsubscribeUrl: links.oneClick },
      composeEmail(alert, links.page),
    );
  }
  await pushed;
}

/**
 * Composes and delivers an alert off the caller's path: nothing it does can delay or fail the
 * request or purchase that raised it.
 */
export function notify(
  n: Notifier | undefined,
  compose: (n: Notifier) => Promise<{ userId: string; alert: Alert } | undefined>,
): void {
  if (!n) return;
  void compose(n)
    .then((out) => (out ? deliver(n, out.userId, out.alert) : undefined))
    .catch((err: unknown) => n.log.warn({ err }, "alert not delivered"));
}

/** An agent's request the user already owns: a cart to approve once, a change, or a connection. */
export async function requestAlert(n: Notifier, requestId: string) {
  const [r] = await n.db.select().from(agentConnections).where(eq(agentConnections.id, requestId));
  if (!r?.userId || r.state !== "PENDING") return undefined;
  const ttl = Math.max(60, Math.floor((r.expiresAt.getTime() - Date.now()) / 1000));
  const total = money(r.totalMinor, r.currency);
  const common = {
    url: `${n.appOrigin}/connect/?c=${r.userCode}`,
    action: "Review and approve",
    push: { ttl, urgency: "high" as const },
    subjectId: r.id,
  };
  const details = [
    { label: "Code", value: r.userCode },
    {
      label: "Expires",
      value: `${new Intl.DateTimeFormat("en-US", { timeStyle: "short", timeZone: "UTC" }).format(r.expiresAt)} UTC`,
    },
  ];
  if (r.kind === "once") {
    const store = storeName(r.merchantIds[0] ?? "");
    return {
      userId: r.userId,
      alert: {
        ...common,
        event: "approval.requested",
        title: `${r.name} wants ${total} at ${store}`,
        body: "Paused until you answer. Approve soon — the price may change.",
        details,
      },
    };
  }
  if (r.parentMandateId) {
    return {
      userId: r.userId,
      alert: {
        ...common,
        event: "change.requested",
        title: `${r.name} asks for more room`,
        body: `${r.reason} Up to ${total}. Nothing changes unless you sign.`,
        details,
      },
    };
  }
  return {
    userId: r.userId,
    alert: {
      ...common,
      event: "connection.requested",
      title: `${r.name} asks to spend up to ${total}`,
      body: "Only approve if you started this.",
      details,
    },
  };
}

/** The user answered a request: its push, if still on a device, is replaced by the answer. */
export async function decidedAlert(n: Notifier, requestId: string) {
  const [r] = await n.db.select().from(agentConnections).where(eq(agentConnections.id, requestId));
  if (!r?.userId || (r.state !== "APPROVED" && r.state !== "DENIED")) return undefined;
  return {
    userId: r.userId,
    alert: {
      event: "request.decided",
      title: r.state === "APPROVED" ? `You approved ${r.name}` : `You declined ${r.name}`,
      body: "Answered. Nothing else to do.",
      url: `${n.appOrigin}/activity/`,
      action: "See your activity",
      push: { ttl: 600, urgency: "low" as const },
      pushOnly: true,
      subjectId: r.id,
    },
  };
}

/** A cart Keelson blocked, or a purchase PayPal captured (email only). */
export async function purchaseAlert(n: Notifier, purchaseId: string, kind: "blocked" | "captured") {
  const [p] = await n.db
    .select({ purchase: purchases, mandate: mandates })
    .from(purchases)
    .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
    .where(eq(purchases.id, purchaseId));
  if (!p) return undefined;
  const { purchase, mandate } = p;
  const name = await agentName(n.db, mandate.id, mandate.operatorAgentId);
  const amount = money(purchase.amountMinor, purchase.currency);
  const store = storeName(purchase.merchantId);
  const logIndex = purchase.logIndex ?? null;
  const alibiUrl = logIndex === null ? null : `${n.verifyOrigin}/a/${purchase.id}`;
  const details = [
    ...(alibiUrl ? [{ label: "Alibi", value: purchase.id, href: alibiUrl }] : []),
    ...(logIndex === null ? [] : [{ label: "Log entry", value: `#${logIndex}` }]),
  ];
  const base = {
    url: `${n.appOrigin}/purchase/?mandate=${mandate.id}&id=${purchase.id}`,
    action: "See the purchase",
    subjectId: purchase.id,
    logIndex,
    alibiUrl,
    details,
  };
  return {
    userId: mandate.userId,
    alert:
      kind === "blocked"
        ? {
            ...base,
            event: "purchase.blocked",
            title: `Keelson blocked a ${amount} cart at ${store}`,
            body: `${name}'s cart broke your mandate, so it was stopped before PayPal. Nothing was paid.`,
            push: { ttl: 3_600, urgency: "high" as const },
          }
        : {
            ...base,
            event: "purchase.captured",
            title: `${name} bought ${amount} at ${store}`,
            body: "Paid with PayPal, within your mandate. Its Alibi proves what was checked.",
            push: null,
          },
  };
}

/** The user stopped every agent: what ended, what PayPal released, and where the log has it. */
export function stopAlert(n: Notifier, userId: string, stop: StopRecord) {
  const sum = (m: StopRecord["released"]) => m.map((x) => money(x.minor, x.currency)).join(" + ");
  const indexes = Object.values(stop.logIndexes);
  const logIndex = indexes[0] === undefined ? null : BigInt(indexes[0]);
  const held = [
    stop.released.length ? `${sum(stop.released)} released` : "",
    stop.releasing.length ? `${sum(stop.releasing)} releasing once pending purchases settle` : "",
  ].filter(Boolean);
  const cards =
    stop.cardsClosed > 0
      ? `${stop.cardsClosed} single-use ${stop.cardsClosed === 1 ? "card" : "cards"} closed. `
      : "";
  return Promise.resolve({
    userId,
    alert: {
      event: "agents.stopped",
      title: "All your agents are stopped",
      body: `${stop.revoked} ${stop.revoked === 1 ? "mandate" : "mandates"} ended and every agent lost access. ${cards}${held.length ? `${held.join("; ")}.` : "Nothing was held."}`,
      url: `${n.appOrigin}/activity/`,
      action: "See your activity",
      details: [
        logIndex === null
          ? {
              label: "Public log",
              value: "Recorded once pending purchases are logged",
            }
          : { label: "Log entry", value: `#${logIndex}` },
      ],
      push: { ttl: 3_600, urgency: "high" as const },
      subjectId: stop.id,
      logIndex,
    },
  });
}
