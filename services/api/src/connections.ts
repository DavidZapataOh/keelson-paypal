import { createHash, randomBytes, randomInt } from "node:crypto";
import { agentConnections, and, type Db, eq, gt, operators } from "@keelson/db";
import type { Mandate } from "@keelson/mandate";
import type { RedisClientType } from "redis";
import { ulid } from "ulid";
import { publishEvent } from "./events.ts";
import { principalChannel } from "./principal.ts";

/** RFC 8628 §6.1: base-20 consonants, no vowels, so no words and nothing confusable. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/** How long the user has to decide, in seconds: the `expires_in` of every request. */
export const REQUEST_TTL_SEC = 900;

/** RFC 8628 §3.2: the minimum polling interval, in seconds. */
const POLL_INTERVAL_SEC = 5;

export type Connection = typeof agentConnections.$inferSelect;

/** `XXXX-XXXX`, about 34.6 bits drawn uniformly. */
export function newUserCode(): string {
  const pick = () =>
    Array.from({ length: 4 }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]).join(
      "",
    );
  return `${pick()}-${pick()}`;
}

/** A user code as typed: case, spaces and the dash do not matter (RFC 8628 §6.1). */
export function normalizeUserCode(input: string): string | undefined {
  const bare = input.toUpperCase().replace(/[\s-]/g, "");
  if (bare.length !== 8 || [...bare].some((ch) => !USER_CODE_ALPHABET.includes(ch))) {
    return undefined;
  }
  return `${bare.slice(0, 4)}-${bare.slice(4)}`;
}

export const hashDeviceCode = (code: string): Buffer =>
  createHash("sha256").update(code, "utf8").digest();

/** A new device code and the hash that is stored in its place. */
export function newDeviceCode(): { code: string; hash: Buffer } {
  const code = randomBytes(32).toString("base64url");
  return { code, hash: hashDeviceCode(code) };
}

/** The request a user may still decide: pending and unexpired. */
export async function openRequest(db: Db, userCode: string): Promise<Connection | undefined> {
  const [row] = await db
    .select()
    .from(agentConnections)
    .where(
      and(
        eq(agentConnections.userCode, userCode),
        eq(agentConnections.state, "PENDING"),
        gt(agentConnections.expiresAt, new Date()),
      ),
    );
  return row;
}

/** What a mandate grants, read the way a request asks for it. */
export interface Grant {
  currency: string;
  perPurchaseMinor: bigint;
  totalMinor: bigint;
  merchantIds: string[];
  notAfter: Date;
}

export function grantOf(m: Mandate): Grant | undefined {
  const range = m.payment.constraints.find((c) => c.type === "payment.amount_range");
  const budget = m.payment.constraints.find((c) => c.type === "payment.budget");
  const merchants = m.checkout.constraints.find((c) => c.type === "checkout.allowed_merchants");
  if (
    range?.type !== "payment.amount_range" ||
    budget?.type !== "payment.budget" ||
    merchants?.type !== "checkout.allowed_merchants"
  ) {
    return undefined;
  }
  return {
    currency: m.payment.currency,
    perPurchaseMinor: BigInt(range.max),
    totalMinor: BigInt(budget.max),
    merchantIds: merchants.allowed.map((x) => x.id),
    notAfter: new Date(m.exp * 1000),
  };
}

/**
 * The mandate fields that grant more than the request asked for, by the request's names. A user
 * may only lower what an agent asked; raising it takes a new request.
 */
export function looserThan(m: Mandate, request: Connection): string[] {
  const grant = grantOf(m);
  if (!grant) return ["limits"];
  const over: string[] = [];
  if (m.agent.operator.agent_id !== request.operatorAgentId.toString()) over.push("agent");
  if (grant.currency !== request.currency) over.push("currency");
  if (grant.perPurchaseMinor > request.perPurchaseMinor) over.push("perPurchase");
  if (grant.totalMinor > request.totalMinor) over.push("total");
  if (grant.merchantIds.some((id) => !request.merchantIds.includes(id))) over.push("merchants");
  if (grant.notAfter > request.notAfter) over.push("until");
  if (request.kind === "once" && m.mode !== "immediate") over.push("mode");
  return over;
}

interface OnceDeps {
  db: Db;
  kv: RedisClientType;
}

/** What an agent polls to learn the user's answer: the RFC 8628 authorization response. */
export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export function deviceAuthorization(
  appOrigin: string,
  userCode: string,
  deviceCode: string,
): DeviceAuthorization {
  const verification = `${appOrigin.replace(/\/$/, "")}/connect`;
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verification,
    verification_uri_complete: `${verification}?c=${userCode}`,
    expires_in: REQUEST_TTL_SEC,
    interval: POLL_INTERVAL_SEC,
  };
}

/**
 * Asks the mandate's user to approve one cart it does not allow (AP2's unresolved constraint):
 * a `once` request for exactly that amount and merchant, announced on the user's `agents`
 * channel. The agent polls the device code it returns.
 */
export async function requestOnce(
  deps: OnceDeps & { appOrigin: string },
  input: {
    mandate: { id: string; userId: string; operatorAgentId: bigint; maxMinor: bigint };
    clientId: string;
    merchantId: string;
    currency: string;
    amountMinor: bigint;
    cartHash: Buffer;
    /** How far over the mandate the cart is, for the prompt; omitted when it is the merchant. */
    overMinor: bigint | null;
  },
): Promise<DeviceAuthorization> {
  const { db } = deps;
  const [operator] = await db
    .select({ name: operators.name })
    .from(operators)
    .where(eq(operators.agentId, input.mandate.operatorAgentId));
  const [named] = await db
    .select({ name: agentConnections.name })
    .from(agentConnections)
    .where(
      and(eq(agentConnections.mandateId, input.mandate.id), eq(agentConnections.state, "APPROVED")),
    );
  const name = named?.name ?? operator?.name ?? "Your agent";
  const device = newDeviceCode();
  const userCode = newUserCode();
  const expiresAt = new Date(Date.now() + REQUEST_TTL_SEC * 1000);
  await db.insert(agentConnections).values({
    id: ulid(),
    kind: "once",
    clientId: input.clientId,
    operatorAgentId: input.mandate.operatorAgentId,
    name,
    reason: `Asks to buy one cart that mandate ${input.mandate.id} does not allow, and nothing else.`,
    userCode,
    deviceCodeHash: device.hash,
    currency: input.currency,
    perPurchaseMinor: input.amountMinor,
    totalMinor: input.amountMinor,
    merchantIds: [input.merchantId],
    notAfter: expiresAt,
    parentMandateId: input.mandate.id,
    cartHash: input.cartHash,
    userId: input.mandate.userId,
    expiresAt,
  });
  await publishEvent(
    deps,
    principalChannel({ kind: "user", subject: input.mandate.userId }, "agents"),
    input.mandate.id,
    {
      type: "approval.requested",
      userCode,
      name,
      amountMinor: input.amountMinor.toString(),
      overMinor: input.overMinor?.toString() ?? null,
      currency: input.currency,
      merchantId: input.merchantId,
      expiresAt: expiresAt.toISOString(),
    },
  );
  return deviceAuthorization(deps.appOrigin, userCode, device.code);
}
