import { createHmac, randomBytes } from "node:crypto";
import { cardAuthorizationDigest, countersignDigest, keelsonDomain } from "@keelson/core/eip712";
import {
  cardAuthorizations,
  cardChargebacks,
  eq,
  mandates,
  operators,
  purchaseCards,
  purchases,
  teeSignatures,
  teeSigners,
  user,
} from "@keelson/db";
import { buildSdPayload, parseMandate } from "@keelson/mandate";
import { pino } from "pino";
import { ulid } from "ulid";
import { type Hex, keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, test } from "vitest";
import demo from "../../../packages/mandate/test/fixtures/demo-mandate.json" with { type: "json" };
import { createApp } from "../src/app.ts";
import { type CardVetoDeps, decide, type NetworkAuthorization } from "../src/cards/authorize.ts";
import { bondClaimMinor, chargebackRecovered } from "../src/cards/chargeback.ts";
import type { CardIssuer } from "../src/cards/issuer.ts";
import { applyChargeback } from "../src/routes/chargebacks.ts";
import type { CardAuthorized, CardAuthorizeRequest, CountersignJson } from "../src/tee/client.ts";
import { VERIFYING_CONTRACT } from "../src/tee/config.ts";
import { countersignMessage } from "../src/tee/coordinator.ts";
import { testDb, testKv } from "./setup.ts";
import { headerPrincipal } from "./tee-live.ts";

const log = pino({ level: "silent" });
const domain = keelsonDomain(421614, VERIFYING_CONTRACT);
const tdx = privateKeyToAccount(generatePrivateKey());
const nitro = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

/** A leg that signs its answer the way the engine does. */
type Answer = { mask: number } | "timeout" | { signer: typeof tdx; mask: number };
function leg(key: typeof tdx, kind: 1 | 2, answer: () => Answer, calls: CardAuthorizeRequest[]) {
  return {
    async cardAuthorize(req: CardAuthorizeRequest): Promise<CardAuthorized> {
      calls.push(req);
      const a = answer();
      if (a === "timeout") throw new Error("timeout");
      const signer = "signer" in a ? a.signer : key;
      const n = req.authorization;
      const message = {
        requestId: req.countersign.requestId,
        countersignDigest: countersignDigest(countersignMessage(req.countersign), domain),
        authorizationHash: keccak256(toHex(n.id)),
        merchantHash: keccak256(toHex(`${n.network_id}\0${n.merchant_name}`)),
        mcc: Number(n.mcc),
        country: toHex(n.merchant_country) as Hex,
        amount: BigInt(n.amount_minor),
        currency: 840,
        decision: a.mask === 0 ? 1 : 2,
        failedMask: a.mask,
        issuedAt: Math.floor(Date.now() / 1000),
      };
      const digest = cardAuthorizationDigest(message, domain);
      return {
        authorization: {
          requestId: message.requestId,
          countersignDigest: message.countersignDigest,
          authorizationHash: message.authorizationHash,
          merchantHash: message.merchantHash,
          mcc: String(message.mcc),
          country: message.country,
          amount: String(message.amount),
          currency: "840",
          decision: String(message.decision),
          failedMask: String(message.failedMask),
          issuedAt: String(message.issuedAt),
        },
        chain_id: 421614,
        digest,
        signature: await signer.sign({ hash: digest }),
        signer: signer.address,
        tee: kind,
      };
    },
  };
}

let answers: { a: () => Answer; b: () => Answer };
const calls: CardAuthorizeRequest[] = [];
const tee = {
  client: {
    a: leg(tdx, 1, () => answers.a(), calls),
    b: leg(nitro, 2, () => answers.b(), calls),
  },
} as unknown as NonNullable<CardVetoDeps["tee"]>;
const deps: CardVetoDeps = { db: testDb, log, tee };

beforeAll(async () => {
  for (const [account, kind] of [
    [tdx, 1],
    [nitro, 2],
  ] as const) {
    await testDb.insert(teeSigners).values({
      address: Buffer.from(account.address.slice(2), "hex"),
      teeKind: kind,
      measurement: `${kind === 1 ? "tdx" : "nitro"}:${"ab".repeat(32)}`,
      binding: {},
      attestation: {},
      expiresAt: new Date(Date.now() + 86_400_000),
    });
  }
});

/** A covered card purchase with an open card, countersigned 2-of-2 by the two test legs. */
async function cardPurchase(state: "OPEN" | "PAUSED" = "OPEN") {
  const userId = `user-${ulid()}`;
  await testDb.insert(user).values({ id: userId, name: "Tester", email: `${userId}@example.test` });
  const agentId = BigInt(`0x${randomBytes(12).toString("hex")}`);
  await testDb.insert(operators).values({
    agentId,
    chainId: 421614,
    agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    name: "op",
    cnfJwk: {},
  });
  const m = parseMandate(structuredClone(demo));
  const mid = ulid();
  await testDb.insert(mandates).values({
    id: mid,
    userId,
    operatorAgentId: agentId,
    state: "ACTIVE",
    rail: "card",
    holdMode: "per_purchase",
    currency: "USD",
    maxMinor: 10_000n,
    remainingMinor: 10_000n,
    merchantIds: ["*"],
    expiresAt: new Date(Date.now() + 86_400_000),
    openMandate: "open",
    mandateHash: randomBytes(32),
    ...(await buildSdPayload(m, () => randomBytes(16))),
  });
  const id = ulid();
  const now = Math.floor(Date.now() / 1000);
  const cs: CountersignJson = {
    requestId: `0x${"00".repeat(16)}${randomBytes(16).toString("hex")}`,
    mandateHash: toHex(randomBytes(32)),
    mandateCommitment: toHex(randomBytes(32)),
    cartHash: toHex(randomBytes(32)),
    agentId: agentId.toString(),
    merchantId: toHex(randomBytes(32)),
    amount: "450",
    currency: "840",
    category: "7",
    evidenceRoot: toHex(randomBytes(32)),
    evalHash: toHex(randomBytes(32)),
    policySetHash: toHex(randomBytes(32)),
    decision: "1",
    failedFieldsMask: "0",
    issuedAt: String(now),
    expiresAt: String(now + 900),
  };
  const digest = countersignDigest(countersignMessage(cs), domain);
  await testDb.insert(purchases).values({
    id,
    mandateId: mid,
    state: "COVERED",
    rail: "card",
    merchantId: "*",
    currency: "USD",
    amountMinor: 450n,
    cartHash: Buffer.from(cs.cartHash.slice(2), "hex"),
    countersign: cs,
    countersignDigest: Buffer.from(digest.slice(2), "hex"),
    countersignMode: "2of2",
    decision: 1,
  });
  for (const account of [tdx, nitro]) {
    await testDb.insert(teeSignatures).values({
      requestId: id,
      signer: Buffer.from(account.address.slice(2), "hex"),
      digest: Buffer.from(digest.slice(2), "hex"),
      signature: Buffer.from((await account.sign({ hash: digest })).slice(2), "hex"),
    });
  }
  const cardToken = `card-${ulid()}`;
  await testDb.insert(purchaseCards).values({
    purchaseId: id,
    issuer: "lithic",
    cardToken,
    lastFour: "4242",
    controls: { mcc: ["5814"], countries: ["US"] },
    state,
    expiresAt: new Date((now + 900) * 1000),
  });
  return { id, cardToken };
}

const coffee = (cardToken: string, over: Partial<NetworkAuthorization> = {}) => ({
  id: `auth-${ulid()}`,
  cardToken,
  amount_minor: 450,
  currency: "USD",
  mcc: "5814",
  merchant_name: "BLUE HARBOR COFFEE",
  merchant_country: "US",
  network_id: "000000012345",
  ...over,
});

describe("the card authorization veto", () => {
  test("approves only what both legs approve, once, and answers a retry the same", async () => {
    answers = { a: () => ({ mask: 0 }), b: () => ({ mask: 0 }) };
    const { id, cardToken } = await cardPurchase();
    const n = coffee(cardToken);
    calls.length = 0;
    const first = await decide(deps, n, performance.now());
    expect(first).toEqual({ approved: true, result: "APPROVED", failedMask: 0 });
    expect(calls).toHaveLength(2);
    // Neither leg is sent anything it could print a card with.
    expect(JSON.stringify(calls)).not.toMatch(/\b\d{15,16}\b/);
    const [stored] = await testDb
      .select()
      .from(cardAuthorizations)
      .where(eq(cardAuthorizations.id, n.id));
    expect(stored?.approved).toBe(true);
    expect(stored?.tdx?.signer).toBe(tdx.address);
    expect(stored?.nitro?.signer).toBe(nitro.address);
    const [card] = await testDb
      .select()
      .from(purchaseCards)
      .where(eq(purchaseCards.purchaseId, id));
    expect(card?.state).toBe("USED");

    calls.length = 0;
    expect(await decide(deps, n, performance.now())).toEqual(first);
    expect(calls).toHaveLength(0);

    const again = await decide(deps, coffee(cardToken), performance.now());
    expect(again.approved).toBe(false);
    expect(again.result).not.toBe("APPROVED");
    expect(calls).toHaveLength(0);
  });

  test("declines with the reason a leg gives", async () => {
    answers = { a: () => ({ mask: 1 << 5 }), b: () => ({ mask: 1 << 5 }) };
    const { cardToken } = await cardPurchase();
    const out = await decide(deps, coffee(cardToken, { mcc: "5812" }), performance.now());
    expect(out).toEqual({ approved: false, result: "UNAUTHORIZED_MERCHANT", failedMask: 1 << 5 });
    answers = { a: () => ({ mask: 1 << 4 }), b: () => ({ mask: 1 << 4 }) };
    const over = await decide(deps, coffee(cardToken, { amount_minor: 451 }), performance.now());
    expect(over.result).toBe("INSUFFICIENT_FUNDS");
  });

  test("declines when a leg does not answer or its answer does not verify", async () => {
    answers = { a: () => ({ mask: 0 }), b: () => "timeout" };
    const { cardToken } = await cardPurchase();
    const out = await decide(deps, coffee(cardToken), performance.now());
    expect(out.approved).toBe(false);
    expect(out.result).toBe("SUSPECTED_FRAUD");

    answers = { a: () => ({ mask: 0 }), b: () => ({ signer: stranger, mask: 0 }) };
    const other = await cardPurchase();
    const forged = await decide(deps, coffee(other.cardToken), performance.now());
    expect(forged.approved).toBe(false);
  });

  test("declines a card that is not open, and a card Keelson did not issue", async () => {
    answers = { a: () => ({ mask: 0 }), b: () => ({ mask: 0 }) };
    const { cardToken } = await cardPurchase("PAUSED");
    calls.length = 0;
    const paused = await decide(deps, coffee(cardToken), performance.now());
    expect(paused).toEqual({ approved: false, result: "CARD_PAUSED", failedMask: 0 });
    expect(calls).toHaveLength(0);
    const unknown = await decide(deps, coffee("card-unknown"), performance.now());
    expect(unknown.result).toBe("SUSPECTED_FRAUD");
  });
});

describe("POST /webhooks/lithic/asa", () => {
  const secret = `whsec_${randomBytes(24).toString("base64")}`;
  const issuer: CardIssuer = {
    name: "lithic",
    issue: async () => ({ token: "t", lastFour: "0000" }),
    open: async () => {},
    close: async () => {},
    embedUrl: () => "https://sandbox.lithic.com/v1/embed/card",
    chargeback: async () => ({ token: "dsp", status: "NEW" }),
    attachEvidence: async () => {},
    verify(body, headers, key) {
      const id = headers.get("webhook-id") ?? "";
      const ts = headers.get("webhook-timestamp") ?? "";
      const want = createHmac("sha256", Buffer.from(key.slice(6), "base64"))
        .update(`${id}.${ts}.${body}`)
        .digest("base64");
      if (!(headers.get("webhook-signature") ?? "").split(" ").includes(`v1,${want}`)) {
        throw new Error("bad signature");
      }
      return JSON.parse(body);
    },
  };
  const app = createApp({
    db: testDb,
    kv: testKv,
    log,
    tee: tee as never,
    cards: { issuer, asaSecret: secret },
  });

  function sign(body: string, key = secret) {
    const id = `msg_${ulid()}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", Buffer.from(key.slice(6), "base64"))
      .update(`${id}.${ts}.${body}`)
      .digest("base64");
    return { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` };
  }

  const asa = (cardToken: string, token = `auth-${ulid()}`) =>
    JSON.stringify({
      token,
      status: "AUTHORIZATION",
      amounts: { cardholder: { amount: 450, currency: "USD", conversion_rate: "1" } },
      card: { token: cardToken, last_four: "4242" },
      merchant: {
        acceptor_id: "000000012345",
        descriptor: "BLUE HARBOR COFFEE",
        mcc: "5814",
        country: "USA",
        city: "SEATTLE",
      },
    });

  test("refuses a request the issuer did not sign", async () => {
    const body = asa("card-x");
    const res = await app.request("/webhooks/lithic/asa", {
      method: "POST",
      headers: sign(body, `whsec_${randomBytes(24).toString("base64")}`),
      body,
    });
    expect(res.status).toBe(400);
  });

  test("answers the issuer with both legs' decision", async () => {
    answers = { a: () => ({ mask: 0 }), b: () => ({ mask: 0 }) };
    const { cardToken } = await cardPurchase();
    const body = asa(cardToken);
    const res = await app.request("/webhooks/lithic/asa", {
      method: "POST",
      headers: sign(body),
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "APPROVED" });
    const second = asa(cardToken);
    const res2 = await app.request("/webhooks/lithic/asa", {
      method: "POST",
      headers: sign(second),
      body: second,
    });
    expect(await res2.json()).toEqual({ result: "VELOCITY_EXCEEDED" });
  });

  test("declines a refund or a balance inquiry", async () => {
    const body = asa("card-x").replace('"AUTHORIZATION"', '"BALANCE_INQUIRY"');
    const res = await app.request("/webhooks/lithic/asa", {
      method: "POST",
      headers: sign(body),
      body,
    });
    expect(await res.json()).toEqual({ result: "SUSPECTED_FRAUD" });
  });
});

describe("chargebacks and the bond", () => {
  test("a chargeback that returned the money leaves nothing for the bond to pay twice", () => {
    expect(chargebackRecovered("SUBMITTED", null, 450n)).toBeNull();
    expect(chargebackRecovered("CASE_WON", "WON_FIRST_CHARGEBACK", 450n)).toBe(450n);
    expect(chargebackRecovered("CASE_CLOSED", "REFUNDED", 450n)).toBe(450n);
    expect(chargebackRecovered("CASE_CLOSED", "CASE_LOST", 450n)).toBe(0n);
    // Nothing is claimed while a chargeback is open.
    expect(bondClaimMinor(450n, [{ status: "SUBMITTED", recoveredMinor: null }])).toBe(0n);
    expect(bondClaimMinor(450n, [{ status: "CASE_WON", recoveredMinor: 450n }])).toBe(0n);
    expect(bondClaimMinor(450n, [{ status: "CASE_CLOSED", recoveredMinor: 200n }])).toBe(250n);
    expect(bondClaimMinor(450n, [{ status: "CASE_CLOSED", recoveredMinor: 0n }])).toBe(450n);
    expect(bondClaimMinor(450n, [])).toBe(450n);
  });
});

describe("POST /v1/purchases/{id}/chargeback", () => {
  const filed: { reason: string; amountMinor: bigint }[] = [];
  const evidence: string[] = [];
  const issuer: CardIssuer = {
    name: "lithic",
    issue: async () => ({ token: "t", lastFour: "0000" }),
    open: async () => {},
    close: async () => {},
    embedUrl: () => "",
    chargeback: async (i) => {
      filed.push(i);
      return { token: `dsp-${ulid()}`, status: "NEW" };
    },
    attachEvidence: async (_token, name) => {
      evidence.push(name);
    },
    verify: () => ({}),
  };

  async function settled() {
    const p = await cardPurchase();
    const [row] = await testDb
      .select({ userId: mandates.userId })
      .from(purchases)
      .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
      .where(eq(purchases.id, p.id));
    await testDb.update(purchases).set({ state: "CAPTURED" }).where(eq(purchases.id, p.id));
    await testDb
      .update(purchaseCards)
      .set({ state: "CLOSED", transactionToken: `txn-${ulid()}`, settledMinor: 450n })
      .where(eq(purchaseCards.purchaseId, p.id));
    return { ...p, userId: row?.userId as string };
  }

  const as = (userId: string) => ({
    "content-type": "application/json",
    "idempotency-key": ulid(),
    "x-test-principal": JSON.stringify({ kind: "user", subject: userId }),
  });

  test("files through the issuer once, and the bond waits for its outcome", async () => {
    const app = createApp({
      db: testDb,
      kv: testKv,
      log,
      authenticate: headerPrincipal,
      cards: { issuer },
    });
    const { id, userId } = await settled();
    const res = await app.request(`/v1/purchases/${id}/chargeback`, {
      method: "POST",
      headers: as(userId),
      body: JSON.stringify({ reason: "not_as_described", note: "Wrong roast" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; networkCodes: unknown; amountMinor: string };
    expect(body.networkCodes).toEqual({ visa: "13.3", mastercard: "4853" });
    expect(body.amountMinor).toBe("450");
    expect(filed.at(-1)?.amountMinor).toBe(450n);

    const again = await app.request(`/v1/purchases/${id}/chargeback`, {
      method: "POST",
      headers: as(userId),
      body: JSON.stringify({ reason: "not_received" }),
    });
    expect(again.status).toBe(409);

    const other = await app.request(`/v1/purchases/${id}/chargeback`, {
      method: "POST",
      headers: as("user-someone-else"),
      body: JSON.stringify({ reason: "not_received" }),
    });
    expect(other.status).toBe(404);

    await applyChargeback(
      { db: testDb },
      { token: body.id, status: "CASE_WON", resolution: "WON_FIRST_CHARGEBACK" },
    );
    const [stored] = await testDb
      .select()
      .from(cardChargebacks)
      .where(eq(cardChargebacks.id, body.id));
    expect(stored?.recoveredMinor).toBe(450n);
  });

  test("refuses more than was settled, and a card not settled yet", async () => {
    const app = createApp({
      db: testDb,
      kv: testKv,
      log,
      authenticate: headerPrincipal,
      cards: { issuer },
    });
    const { id, userId } = await settled();
    const over = await app.request(`/v1/purchases/${id}/chargeback`, {
      method: "POST",
      headers: as(userId),
      body: JSON.stringify({ reason: "not_received", amountMinor: "451" }),
    });
    expect(over.status).toBe(422);
    const open = await cardPurchase();
    const [row] = await testDb
      .select({ userId: mandates.userId })
      .from(purchases)
      .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
      .where(eq(purchases.id, open.id));
    const early = await app.request(`/v1/purchases/${open.id}/chargeback`, {
      method: "POST",
      headers: as(row?.userId as string),
      body: JSON.stringify({ reason: "not_received" }),
    });
    expect(early.status).toBe(409);
  });
});
