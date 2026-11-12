import { execFileSync } from "node:child_process";
import { createECDH, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { globalAgent, createServer as httpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentStops,
  alertEmails,
  eq,
  mandates,
  operators,
  purchases,
  pushSubscriptions,
  sentEmails,
  user,
} from "@keelson/db";
import { pino } from "pino";
import { Resend } from "resend";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { publishEvent } from "../src/events.ts";
import { signLink } from "../src/notify/email.ts";
import {
  deliver,
  type Notifier,
  notify,
  purchaseAlert,
  stopAlert,
} from "../src/notify/notifier.ts";
import { declarativePush, pushTopic } from "../src/notify/push.ts";
import { principalChannel } from "../src/principal.ts";
import { testDb, testKv } from "./setup.ts";
import { headerPrincipal } from "./tee-live.ts";

const log = pino({ level: "silent" });
const SECRET = randomBytes(32).toString("hex");
const VAPID = {
  subject: "mailto:notify@keelson.finance",
  publicKey:
    "BIgttCNLXCTetxKzJEOOm6rJJbiwwq5XUgWNC14Q1XDLvFkaycjWn8zaTjySVi7eoFU3_CE9Yr8vCVc8y8mtOqg",
  privateKey: "",
};
const notifier: Notifier = {
  db: testDb,
  log,
  appOrigin: "https://app.keelson.finance",
  apiOrigin: "https://api.keelson.finance",
  verifyOrigin: "https://verify.keelson.finance",
  secret: SECRET,
};
const app = createApp({
  db: testDb,
  kv: testKv,
  log,
  authenticate: headerPrincipal,
  appOrigin: notifier.appOrigin,
  notifier,
});

const asUser = (subject: string) => ({
  "x-test-principal": JSON.stringify({ kind: "user", subject }),
});

async function newUser(): Promise<string> {
  const id = `user-${ulid()}`;
  await testDb.insert(user).values({ id, name: "Buyer", email: `${id}@sandbox.paypal.test` });
  return id;
}

const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(path, {
    method,
    headers: {
      ...(method === "POST" ? { "idempotency-key": ulid() } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** A browser's push keys: a P-256 public key and a 16-byte auth secret (RFC 8291). */
function browserKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
}

/**
 * A push service on localhost over TLS that answers each endpoint path with its status, and
 * records what it received.
 */
let pushService: {
  origin: string;
  close: () => void;
  seen: { path: string; headers: Record<string, unknown>; bytes: number }[];
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "push-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(join(dir, "cert.pem"));
  // web-push sends through Node's global HTTPS agent; it trusts this test service only.
  globalAgent.options.ca = cert;
  const seen: { path: string; headers: Record<string, unknown>; bytes: number }[] = [];
  const server = httpsServer({ key: readFileSync(join(dir, "key.pem")), cert }, (req, res) => {
    let bytes = 0;
    req.on("data", (d: Buffer) => {
      bytes += d.length;
    });
    req.on("end", () => {
      seen.push({ path: req.url ?? "", headers: req.headers, bytes });
      res.writeHead(Number((req.url ?? "/201").split("/")[1])).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  pushService = {
    origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
    seen,
  };
  const { generateVAPIDKeys } = await import("web-push");
  const keys = generateVAPIDKeys();
  VAPID.publicKey = keys.publicKey;
  VAPID.privateKey = keys.privateKey;
});
afterAll(() => {
  pushService?.close();
  globalAgent.options.ca = undefined;
});

describe("phone approvals over Web Push", () => {
  test("without VAPID keys the key and the test answer 503", async () => {
    const sub = await newUser();
    expect((await call("GET", "/v1/push/key", asUser(sub))).status).toBe(503);
    expect((await call("POST", "/v1/push/test", asUser(sub))).status).toBe(503);
  });

  test("a subscription is stored over https only, then removed", async () => {
    const sub = await newUser();
    const keys = browserKeys();
    const endpoint = `${pushService.origin}/201/${ulid()}`;
    const bad = await call("POST", "/v1/push/subscriptions", asUser(sub), {
      endpoint: endpoint.replace("https:", "http:"),
      keys,
    });
    expect(bad.status).toBe(422);
    const ok = await call("POST", "/v1/push/subscriptions", asUser(sub), {
      endpoint,
      expirationTime: null,
      keys,
    });
    expect(ok.status).toBe(201);
    expect(
      await testDb.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, sub)),
    ).toHaveLength(1);
    const gone = await call("DELETE", "/v1/push/subscriptions", asUser(sub), { endpoint });
    expect(gone.status).toBe(204);
    expect(
      await testDb.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, sub)),
    ).toHaveLength(0);
  });

  test("pushes are encrypted and VAPID-signed; a 410 or 404 subscription is deleted", async () => {
    const withPush = createApp({
      db: testDb,
      kv: testKv,
      log,
      authenticate: headerPrincipal,
      notifier: { ...notifier, vapid: VAPID },
    });
    const sub = await newUser();
    for (const status of [201, 410, 404]) {
      const res = await withPush.request("/v1/push/subscriptions", {
        method: "POST",
        headers: { "idempotency-key": ulid(), "content-type": "application/json", ...asUser(sub) },
        body: JSON.stringify({
          endpoint: `${pushService.origin}/${status}/${ulid()}`,
          keys: browserKeys(),
        }),
      });
      expect(res.status).toBe(201);
    }
    const key = await withPush.request("/v1/push/key", { headers: asUser(sub) });
    expect(await key.json()).toEqual({ publicKey: VAPID.publicKey });

    const before = pushService.seen.length;
    const res = await withPush.request("/v1/push/test", {
      method: "POST",
      headers: { "idempotency-key": ulid(), ...asUser(sub) },
    });
    expect(await res.json()).toEqual({ sent: 1 });
    const got = pushService.seen.slice(before);
    expect(got).toHaveLength(3);
    for (const g of got) {
      expect(g.headers["content-encoding"]).toBe("aes128gcm");
      expect(String(g.headers.authorization)).toMatch(/^vapid t=.+, k=/);
      expect(g.headers.ttl).toBe("60");
      expect(g.bytes).toBeGreaterThan(0);
    }
    const left = await testDb
      .select({ endpoint: pushSubscriptions.endpoint })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, sub));
    expect(left.map((l) => l.endpoint.split("/")[3])).toEqual(["201"]);
  });
});

describe("pushes about one subject", () => {
  test("carry its RFC 8030 topic and a Declarative Web Push message", async () => {
    const sub = await newUser();
    await testDb.insert(pushSubscriptions).values({
      id: ulid(),
      userId: sub,
      endpoint: `${pushService.origin}/201/${ulid()}`,
      ...browserKeys(),
    });
    const request = ulid();
    const before = pushService.seen.length;
    await deliver({ ...notifier, vapid: VAPID }, sub, {
      event: "approval.requested",
      title: "Shopping agent wants $94.00 at RunFast",
      body: "Paused until you answer.",
      url: "https://app.keelson.finance/connect/?c=BCDF-GHJK",
      action: "Review and approve",
      push: { ttl: 600, urgency: "high" },
      subjectId: request,
    });
    const [got] = pushService.seen.slice(before);
    const topic = createHash("sha256").update(request).digest("base64url").slice(0, 32);
    expect(got?.headers.topic).toBe(topic);
    expect(pushTopic(request)).toMatch(/^[\w-]{32}$/);
    expect(got?.headers.urgency).toBe("high");
  });

  test("the message is what Safari shows with no service worker", () => {
    const message = declarativePush({
      title: "You approved Shopping agent",
      body: "Answered.",
      url: "https://app.keelson.finance/activity/",
      tag: "01M7REQUEST000000000000000",
    });
    expect(message).toEqual({
      web_push: 8030,
      notification: {
        title: "You approved Shopping agent",
        body: "Answered.",
        navigate: "https://app.keelson.finance/activity/",
        tag: "01M7REQUEST000000000000000",
        lang: "en",
        dir: "ltr",
        silent: false,
      },
    });
  });
});

describe("email alerts", () => {
  /** The confirmation link's token for the user's current nonce, as the email carries it. */
  async function confirmToken(sub: string, exp = Math.floor(Date.now() / 1000) + 3600) {
    const [row] = await testDb.select().from(alertEmails).where(eq(alertEmails.userId, sub));
    return signLink(SECRET, { p: "confirm", u: sub, n: row?.confirmNonce as string, exp });
  }

  test("an address gets mail only once its single-use, expiring link is opened", async () => {
    const sub = await newUser();
    const set = await call("PUT", "/v1/alerts/email", asUser(sub), { address: "me@keelson.test" });
    expect(set.status).toBe(202);
    expect(await set.json()).toEqual({ address: "me@keelson.test", confirmed: false });
    // One confirmation a minute.
    expect(
      (await call("PUT", "/v1/alerts/email", asUser(sub), { address: "me@keelson.test" })).status,
    ).toBe(429);
    const [confirmMail] = await testDb.select().from(sentEmails).where(eq(sentEmails.userId, sub));
    expect(confirmMail).toMatchObject({ event: "email.confirm", sentAt: null });

    // Nothing is mailed to an unconfirmed address.
    await deliver(notifier, sub, {
      event: "test",
      title: "t",
      body: "b",
      url: "https://app.keelson.finance",
      action: "Open",
      push: null,
    });
    expect(await testDb.select().from(sentEmails).where(eq(sentEmails.userId, sub))).toHaveLength(
      1,
    );

    const expired = await confirmToken(sub, Math.floor(Date.now() / 1000) - 1);
    expect((await call("POST", "/v1/alerts/email/confirm", {}, { token: expired })).status).toBe(
      404,
    );
    const token = await confirmToken(sub);
    const forged = `${token.slice(0, -2)}AA`;
    expect((await call("POST", "/v1/alerts/email/confirm", {}, { token: forged })).status).toBe(
      404,
    );
    const ok = await call("POST", "/v1/alerts/email/confirm", {}, { token });
    expect(await ok.json()).toEqual({ address: "me@keelson.test" });
    expect((await call("POST", "/v1/alerts/email/confirm", {}, { token })).status).toBe(404);
    const state = await call("GET", "/v1/alerts/email", asUser(sub));
    expect(await state.json()).toEqual({ address: "me@keelson.test", confirmed: true });
  });

  async function confirmed(sub: string, address = "me@keelson.test") {
    await testDb.insert(alertEmails).values({ userId: sub, address, confirmedAt: new Date() });
  }

  test("an app acting for the user asks for a mandate: the user is alerted at once", async () => {
    const sub = await newUser();
    await confirmed(sub);
    const host = `host-${ulid()}`;
    await testDb.insert(operators).values({
      agentId: BigInt(`0x${randomBytes(10).toString("hex")}`),
      chainId: 421614,
      agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
      name: "Anthropic Labs",
      cnfJwk: {},
      clientId: host,
    });
    const res = await app.request("/v1/connections", {
      method: "POST",
      headers: {
        "idempotency-key": ulid(),
        "content-type": "application/json",
        "x-test-principal": JSON.stringify({
          kind: "client",
          subject: host,
          user: sub,
          scopes: ["mandates:request"],
        }),
      },
      body: JSON.stringify({
        name: "Claude",
        reason:
          "I am Claude, buying the running shoes you asked for in this chat. I compare prices at RunFast and check out only what you named.",
        limits: {
          currency: "USD",
          perPurchaseMinor: 5_000,
          totalMinor: 10_000,
          merchants: ["mrc_runfast"],
          until: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        },
      }),
    });
    const body = (await res.json()) as { request_id: string };
    expect(res.status, JSON.stringify(body)).toBe(201);
    const { request_id } = body;
    const mail = await vi.waitFor(async () => {
      const [row] = await testDb
        .select()
        .from(sentEmails)
        .where(eq(sentEmails.subjectId, request_id));
      if (!row) throw new Error("not yet");
      return row;
    });
    expect(mail).toMatchObject({
      userId: sub,
      event: "connection.requested",
      subject: "Claude asks to spend up to $100.00",
    });
  });

  test("a blocked cart is emailed with its Alibi link and log index, and kept in the trail", async () => {
    const sub = await newUser();
    await confirmed(sub);
    const agentId = BigInt(`0x${randomBytes(10).toString("hex")}`);
    await testDb.insert(operators).values({
      agentId,
      chainId: 421614,
      agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
      name: "Anthropic Labs",
      cnfJwk: {},
    });
    const mid = ulid();
    await testDb.insert(mandates).values({
      id: mid,
      userId: sub,
      operatorAgentId: agentId,
      state: "ACTIVE",
      currency: "USD",
      maxMinor: 10_000n,
      remainingMinor: 10_000n,
      merchantIds: ["mrc_runfast"],
      expiresAt: new Date(Date.now() + 86_400_000),
      openMandate: "open",
    });
    const pid = ulid();
    const logIndex = BigInt(Date.now()) * 1000n + BigInt(randomBytes(1)[0] as number);
    await testDb.insert(purchases).values({
      id: pid,
      mandateId: mid,
      state: "DENIED",
      merchantId: "mrc_runfast",
      currency: "USD",
      amountMinor: 14_000n,
      cartHash: randomBytes(32),
      logIndex,
    });
    notify(notifier, (n) => purchaseAlert(n, pid, "blocked"));
    const mail = await vi.waitFor(async () => {
      const [row] = await testDb.select().from(sentEmails).where(eq(sentEmails.subjectId, pid));
      if (!row) throw new Error("not yet");
      return row;
    });
    expect(mail).toMatchObject({
      event: "purchase.blocked",
      subject: "Keelson blocked a $140.00 cart at RunFast",
      logIndex,
      alibiUrl: `https://verify.keelson.finance/a/${pid}`,
      sentAt: null,
    });

    const trail = await (await call("GET", "/v1/alerts/emails", asUser(sub))).json();
    expect(trail.emails[0]).toMatchObject({
      event: "purchase.blocked",
      logIndex: logIndex.toString(),
      alibiUrl: `https://verify.keelson.finance/a/${pid}`,
    });

    const feed = await (await call("GET", `/v1/activity`, asUser(sub))).json();
    expect(feed.rows).toEqual([]);
    await publishEvent(
      { db: testDb, kv: testKv },
      principalChannel({ kind: "user", subject: sub }, `mandate:${mid}`),
      pid,
      { type: "purchase.denied", purchaseId: pid, mandateId: mid },
    );
    const rows = (await (await call("GET", "/v1/activity", asUser(sub))).json()).rows;
    expect(rows).toEqual([
      expect.objectContaining({
        tone: "bad",
        line: "Keelson blocked Anthropic Labs's $140.00 cart at RunFast. Nothing was paid.",
        alibiUrl: `https://verify.keelson.finance/a/${pid}`,
        logIndex: logIndex.toString(),
        agentId: agentId.toString(),
      }),
    ]);
    const other = await call("GET", "/v1/activity?agent=1", asUser(sub));
    expect((await other.json()).rows).toEqual([]);
  });

  test("a stop says what was released, and that the log records it once purchases are logged", async () => {
    const sub = await newUser();
    await confirmed(sub);
    const stop = ulid();
    await testDb.insert(agentStops).values({ id: stop, userId: sub });
    const alert = await stopAlert(notifier, sub, {
      id: stop,
      revoked: 2,
      cardsClosed: 1,
      released: [{ currency: "USD", minor: "5000" }],
      releasing: [{ currency: "USD", minor: "1400" }],
      mandateHashes: [],
      logIndexes: {},
      logged: false,
      createdAt: new Date().toISOString(),
    });
    expect(alert.alert.body).toBe(
      "2 mandates ended and every agent lost access. 1 single-use card closed. $50.00 released; $14.00 releasing once pending purchases settle.",
    );
    expect(alert.alert.details).toEqual([
      { label: "Public log", value: "Recorded once pending purchases are logged" },
    ]);
    await publishEvent(
      { db: testDb, kv: testKv },
      principalChannel({ kind: "user", subject: sub }, "agents"),
      stop,
      { type: "agents.stopped", stopId: stop, revoked: 2 },
    );
    await testDb
      .update(agentStops)
      .set({ logIndexes: { "keelson.finance/alibi-log/sepolia": "77" } })
      .where(eq(agentStops.id, stop));
    const rows = (await (await call("GET", "/v1/activity", asUser(sub))).json()).rows;
    expect(rows[0]).toMatchObject({
      tone: "bad",
      line: "You stopped every agent: 2 mandates ended.",
      logIndex: "77",
    });
  });

  test("one click unsubscribes with no session or Idempotency-Key (RFC 8058)", async () => {
    const sub = await newUser();
    await confirmed(sub, "Me@Keelson.test");
    const { unsubscribeLinks } = await import("../src/notify/notifier.ts");
    const { oneClick } = unsubscribeLinks(notifier, sub, "Me@Keelson.test");
    const url = new URL(oneClick);
    expect(url.origin).toBe("https://api.keelson.finance");
    const res = await app.request(`${url.pathname}${url.search}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(res.status).toBe(200);
    expect(await testDb.select().from(alertEmails).where(eq(alertEmails.userId, sub))).toEqual([]);
    const forged = await app.request(`${url.pathname}?token=${url.searchParams.get("token")}x`, {
      method: "POST",
    });
    expect(forged.status).toBe(404);
  });
});

describe.runIf(process.env.RESEND_API_KEY)("sending through Resend", () => {
  test("an alert reaches Resend with one-click unsubscribe headers", async () => {
    const sub = await newUser();
    // Resend's test inbox: accepted and delivered, never a real person.
    await testDb
      .insert(alertEmails)
      .values({ userId: sub, address: "delivered@resend.dev", confirmedAt: new Date() });
    await deliver({ ...notifier, resend: new Resend(process.env.RESEND_API_KEY) }, sub, {
      event: "test",
      title: "Keelson alert test",
      body: "Sent by the API's test suite.",
      url: "https://app.keelson.finance/alerts/",
      action: "Open Keelson",
      push: null,
    });
    const [row] = await testDb.select().from(sentEmails).where(eq(sentEmails.userId, sub));
    expect(row?.error).toBeNull();
    expect(row?.sentAt).toBeInstanceOf(Date);
    expect(row?.providerId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
