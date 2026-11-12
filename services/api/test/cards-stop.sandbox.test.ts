import { randomBytes } from "node:crypto";
import { eq, mandates, operators, purchaseCards, purchases, user } from "@keelson/db";
import Lithic from "lithic";
import { pino } from "pino";
import { ulid } from "ulid";
import { describe, expect, test } from "vitest";
import { LithicIssuer } from "../src/cards/issuer.ts";
import { stopAgents } from "../src/stop.ts";
import { testDb, testKv } from "./setup.ts";

const key = process.env.LITHIC_API_KEY;

/** A covered card purchase whose single-use card is open at Lithic's sandbox. */
async function openCard(issuer: LithicIssuer) {
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
  const mandateId = ulid();
  await testDb.insert(mandates).values({
    id: mandateId,
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
    mandateHash: randomBytes(32),
  });
  const purchaseId = ulid();
  await testDb.insert(purchases).values({
    id: purchaseId,
    mandateId,
    state: "COVERED",
    rail: "card",
    merchantId: "*",
    currency: "USD",
    amountMinor: 450n,
    cartHash: randomBytes(32),
    countersignMode: "2of2",
    decision: 1,
  });
  const card = await issuer.issue({
    spendLimitMinor: 450n,
    mcc: ["5814"],
    countries: ["US"],
    memo: purchaseId,
  });
  await issuer.open(card.token);
  await testDb.insert(purchaseCards).values({
    purchaseId,
    issuer: "lithic",
    cardToken: card.token,
    lastFour: card.lastFour,
    controls: { mcc: ["5814"], countries: ["US"] },
    state: "OPEN",
    expiresAt: new Date(Date.now() + 900_000),
  });
  return { userId, purchaseId, cardToken: card.token };
}

describe.skipIf(!key)("stopping every agent on Lithic's sandbox", () => {
  test("closes the open single-use card at the issuer, and a charge on it is declined", async () => {
    const issuer = new LithicIssuer(key as string);
    const lithic = new Lithic({ apiKey: key as string, environment: "sandbox" });
    const { userId, purchaseId, cardToken } = await openCard(issuer);
    const started = performance.now();
    const stop = await stopAgents(
      { db: testDb, kv: testKv, log: pino({ level: "silent" }), cards: { issuer } },
      userId,
    );
    const ms = performance.now() - started;
    expect(stop.cardsClosed).toBe(1);
    expect(ms).toBeLessThan(3_000);
    expect((await lithic.cards.retrieve(cardToken)).state).toBe("CLOSED");
    const [card] = await testDb
      .select()
      .from(purchaseCards)
      .where(eq(purchaseCards.purchaseId, purchaseId));
    expect(card?.state).toBe("CLOSED");
    const pan = (await lithic.cards.retrieve(cardToken)).pan;
    if (pan) {
      const sim = await lithic.transactions.simulateAuthorization({
        amount: 450,
        descriptor: "BLUE HARBOR COFFEE",
        pan,
        mcc: "5814",
      });
      // The sandbox records the simulated authorization shortly after answering.
      await expect
        .poll(
          () =>
            lithic.transactions
              .retrieve(sim.token as string)
              .then((t) => `${t.status} ${t.result}`)
              .catch(() => "pending"),
          { timeout: 10_000, interval: 1_000 },
        )
        .toBe("DECLINED CARD_CLOSED");
    }
    console.info(`stop to card CLOSED at Lithic: ${ms.toFixed(0)} ms`);
  }, 30_000);
});
