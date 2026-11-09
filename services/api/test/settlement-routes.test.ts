import { randomBytes } from "node:crypto";
import { mandates, merchantSettlement, operators, purchases, user } from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { KEELSON_TREASURY, payeeFor, SETTLEMENT, settlementOf } from "../src/merchants.ts";
import { settlementPreferenceTypedData } from "../src/routes/merchants-settlement.ts";
import { testDb, testKv } from "./setup.ts";
import { headerPrincipal } from "./tee-live.ts";

const runfast = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  authenticate: headerPrincipal,
  merchantSigners: { mrc_runfast: runfast.address },
});
const merchant = {
  "content-type": "application/json",
  "x-test-principal": JSON.stringify({
    kind: "client",
    subject: "settlement-test",
    scopes: ["merchants:write"],
  }),
};
const put = (merchantId: string, body: unknown) =>
  app.request(`/v1/merchants/${merchantId}/settlement`, {
    method: "PUT",
    headers: merchant,
    body: JSON.stringify(body),
  });

let nonce = 0n;
const hour = () => BigInt(Math.floor(Date.now() / 1000) + 3_600);

/** A preference signed by `by` (the merchant unless said otherwise), with a fresh nonce. */
async function signed(
  pref: { rail: "pyusd" | "paypal"; paypal_receiver?: string },
  opts: { by?: typeof runfast; nonce?: bigint; deadline?: bigint; merchantId?: string } = {},
) {
  const n = opts.nonce ?? ++nonce;
  const deadline = opts.deadline ?? hour();
  const signature = await (opts.by ?? runfast).signTypedData(
    settlementPreferenceTypedData({
      merchantId: opts.merchantId ?? "mrc_runfast",
      rail: pref.rail,
      paypalReceiver: pref.paypal_receiver ?? "",
      nonce: n,
      deadline,
    }),
  );
  return {
    ...pref,
    nonce: n.toString(),
    deadline: deadline.toString(),
    merchant_signature: signature,
  };
}

let shipped: string;

beforeAll(async () => {
  await testDb.delete(merchantSettlement);
  const userId = ulid();
  await testDb.insert(user).values({ id: userId, name: "Tester", email: `${userId}@example.test` });
  const agentId = BigInt(Date.now());
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
    currency: "USD",
    maxMinor: 2_000n,
    remainingMinor: 2_000n,
    merchantIds: ["mrc_runfast"],
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  shipped = ulid();
  await testDb.insert(purchases).values({
    id: shipped,
    mandateId,
    merchantId: "mrc_runfast",
    currency: "USD",
    amountMinor: 100n,
    cartHash: randomBytes(32),
    state: "COVERED",
  });
});

describe("settlement preference", () => {
  test("merchants are paid in PYUSD until they choose PayPal", async () => {
    expect(await settlementOf(testDb, "mrc_runfast")).toEqual({
      rail: "pyusd",
      paypalReceiver: null,
    });
    expect(payeeFor("mrc_runfast", "pyusd")).toBe(SETTLEMENT.mrc_runfast);
    expect(payeeFor("mrc_runfast", "paypal")).toBe(KEELSON_TREASURY);
  });

  test("the paypal rail needs a receiver", async () => {
    expect((await put("mrc_runfast", await signed({ rail: "paypal" }))).status).toBe(422);
    expect(
      (await put("mrc_runfast", await signed({ rail: "paypal", paypal_receiver: "nope" }))).status,
    ).toBe(422);
  });

  test("a PayPal receiver is stored and switching back clears it", async () => {
    const res = await put(
      "mrc_runfast",
      await signed({ rail: "paypal", paypal_receiver: "store@example.com" }),
    );
    expect(res.status).toBe(200);
    expect(await settlementOf(testDb, "mrc_runfast")).toEqual({
      rail: "paypal",
      paypalReceiver: "store@example.com",
    });
    expect((await put("mrc_runfast", await signed({ rail: "pyusd" }))).status).toBe(200);
    expect((await settlementOf(testDb, "mrc_runfast")).paypalReceiver).toBeNull();
  });

  test("only the merchant's own signature changes where it is paid", async () => {
    const before = await settlementOf(testDb, "mrc_runfast");
    const unsigned = await put("mrc_runfast", { rail: "paypal", paypal_receiver: "a@example.com" });
    expect(unsigned.status).toBe(422);
    const forged = await put(
      "mrc_runfast",
      await signed({ rail: "paypal", paypal_receiver: "thief@example.com" }, { by: stranger }),
    );
    expect(forged.status).toBe(403);
    const tampered = {
      ...(await signed({ rail: "paypal", paypal_receiver: "store@example.com" })),
      paypal_receiver: "thief@example.com",
    };
    expect((await put("mrc_runfast", tampered)).status).toBe(403);
    const elsewhere = await put(
      "mrc_runfast",
      await signed({ rail: "pyusd" }, { merchantId: "mrc_other" }),
    );
    expect(elsewhere.status).toBe(403);
    expect(await settlementOf(testDb, "mrc_runfast")).toEqual(before);
  });

  test("a signature is used once and an older one never undoes a newer choice", async () => {
    const old = await signed({ rail: "paypal", paypal_receiver: "old@example.com" });
    const current = await signed({ rail: "paypal", paypal_receiver: "new@example.com" });
    expect((await put("mrc_runfast", current)).status).toBe(200);
    expect((await put("mrc_runfast", current)).status).toBe(409);
    expect((await put("mrc_runfast", old)).status).toBe(409);
    expect((await settlementOf(testDb, "mrc_runfast")).paypalReceiver).toBe("new@example.com");
  });

  test("an expired signature is refused", async () => {
    const res = await put(
      "mrc_runfast",
      await signed({ rail: "pyusd" }, { deadline: BigInt(Math.floor(Date.now() / 1000) - 1) }),
    );
    expect(res.status).toBe(422);
  });

  test("unknown merchants and clients without the scope are refused", async () => {
    expect((await put("mrc_nobody", await signed({ rail: "pyusd" }))).status).toBe(404);
    const res = await app.request("/v1/merchants/mrc_runfast/settlement", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rail: "pyusd" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/purchases/{id}/tracking", () => {
  test("a purchase that was not captured does not ship", async () => {
    const res = await app.request(`/v1/purchases/${shipped}/tracking`, {
      method: "POST",
      headers: { ...merchant, "idempotency-key": ulid() },
      body: JSON.stringify({ carrier: "USPS", tracking_number: "9400100000000000000000" }),
    });
    expect(res.status).toBe(409);
  });
});
