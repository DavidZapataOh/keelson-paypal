import "../src/tee/attest.ts";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  c1c3Statement,
  c3Statement,
  verifyAnonymousPurchase,
  verifyC3,
} from "@keelson/alibi/verify";
import { mandates, operators, passkey, purchases, user, userSetRoots } from "@keelson/db";
import { hSd, mandateChallenge } from "@keelson/mandate";
import { pino } from "pino";
import { ulid } from "ulid";
import { beforeAll, describe, expect, test } from "vitest";
import c1 from "../../../contracts/test/vectors/c1-anonymous-recursive.json" with { type: "json" };
import vector from "../../../packages/mandate/test/vectors/c3.json" with { type: "json" };
import { createApp } from "../src/app.ts";
import { composable, proveAnonymousPurchase } from "../src/zk/c1c3.ts";
import { proveAnonymousMandate } from "../src/zk/c3.ts";
import { testDb, testKv } from "./setup.ts";

const log = pino({ level: "silent" });
const app = createApp({ db: testDb, kv: testKv, log });
const get = (path: string) => app.request(path);

const userId = `user-${randomBytes(6).toString("hex")}`;
const agentId = BigInt(vector.mandate.agent.operator.agent_id);
const salt = `0x${Buffer.from(vector.salt, "base64url").toString("hex")}`;
const cm = BigInt(vector.payment.statement.cm);
const M = mandateChallenge(hSd(vector.payloadSd), cm);
const mandateHash = `0x${Buffer.from(M).toString("hex")}`;
const hex32 = (x: bigint) => `0x${x.toString(16).padStart(64, "0")}`;

/** A COSE_Key of a fresh ES256 key: another registered user. */
function otherPasskey(): string {
  const { x, y } = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({
    format: "jwk",
  });
  return Buffer.concat([
    Buffer.from("a5010203262001215820", "hex"),
    Buffer.from(x as string, "base64url"),
    Buffer.from("225820", "hex"),
    Buffer.from(y as string, "base64url"),
  ]).toString("base64");
}

const passkeyRow = (publicKey: string, createdAt: Date) => ({
  id: crypto.randomUUID(),
  userId,
  credentialID: randomBytes(16).toString("base64url"),
  publicKey,
  counter: 0,
  deviceType: "multiDevice",
  backedUp: true,
  createdAt,
});

async function storeMandate(id: string, payloadSd: object = vector.payloadSd) {
  await testDb.insert(mandates).values({
    id,
    userId,
    operatorAgentId: agentId,
    state: "SIGNED",
    currency: "USD",
    maxMinor: 10_000n,
    remainingMinor: 10_000n,
    merchantIds: ["store"],
    expiresAt: new Date(vector.mandate.exp * 1000),
    mandateHash: Buffer.from(mandateChallenge(hSd(payloadSd), cm)),
    commitment: Buffer.from(hex32(cm).slice(2), "hex"),
    payloadSd,
    disclosures: vector.disclosures,
    userAuth: vector.payment.assertion,
  });
}

const id = ulid();

beforeAll(async () => {
  await testDb.insert(user).values({ id: userId, name: "Tester", email: `${userId}@example.test` });
  await testDb
    .insert(operators)
    .values({
      agentId,
      chainId: 421614,
      agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
      name: "op",
      cnfJwk: {},
    })
    .onConflictDoNothing();
  const t = Date.now();
  await testDb
    .insert(passkey)
    .values([
      passkeyRow(otherPasskey(), new Date(t - 3000)),
      passkeyRow(vector.publicKey, new Date(t - 2000)),
      passkeyRow(otherPasskey(), new Date(t - 1000)),
    ]);
  await storeMandate(id);
});

describe("proveAnonymousMandate", () => {
  test("proves that a registered user signed the mandate, and serves the proof without the user", {
    timeout: 120_000,
  }, async () => {
    const c3 = await proveAnonymousMandate({ db: testDb, log }, id, salt);
    const root = c3.public_inputs[2] as string;
    expect(c3.public_inputs).toEqual(
      c3Statement({ mandateCommitment: hex32(cm), mandateHash, userSetRoot: root }),
    );
    expect(await verifyC3(c3.proof, c3.public_inputs)).toBe(true);

    const res = await get(`/v1/anonymous-mandates/${mandateHash}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as {
      proof: string;
      public_inputs: string[];
      user_set_root: string;
    };
    expect(body.user_set_root).toBe(root);
    expect(await verifyC3(body.proof, body.public_inputs)).toBe(true);
    const { x, y } = vector.mandate.user.cred.jwk;
    for (const secret of [x, y, userId, vector.publicKey, vector.payment.assertion.signature]) {
      expect(text).not.toContain(secret);
    }

    const known = await get(`/v1/user-set/roots/${root}`);
    expect(known.status).toBe(200);
    expect((await known.json()) as { size: number }).toMatchObject({ root });
  });

  test("keeps the first proof of a mandate", { timeout: 120_000 }, async () => {
    const first = await proveAnonymousMandate({ db: testDb, log }, id, salt);
    expect(await proveAnonymousMandate({ db: testDb, log }, id, salt)).toEqual(first);
  });

  test("proves nothing for a payload the passkey did not sign, nor under another salt", async () => {
    const other = ulid();
    await storeMandate(other, { ...vector.payloadSd, iat: vector.payloadSd.iat - 1 });
    for (const s of [salt, `0x${"00".repeat(16)}`]) {
      await expect(proveAnonymousMandate({ db: testDb, log }, other, s)).rejects.toThrow(
        "not over this mandate's challenge",
      );
    }
    const row = await testDb.query.mandates.findFirst({ where: (m, { eq }) => eq(m.id, other) });
    expect(row?.c3Proof).toBeNull();
  });
});

/** A purchase of the vector mandate whose leg A proof is the vector's recursive C1 proof. */
async function storePurchase(mandateId: string, inputs = c1.publicInputs) {
  const [cmIn, amount, currency, category, merchant, now, cart, operator] = inputs as string[];
  const purchaseId = ulid();
  await testDb.insert(purchases).values({
    id: purchaseId,
    mandateId,
    merchantId: "store",
    currency: "USD",
    amountMinor: BigInt(amount as string),
    cartHash: Buffer.from((cart as string).slice(2), "hex"),
    countersign: {
      mandateHash,
      mandateCommitment: cmIn as string,
      amount: BigInt(amount as string).toString(),
      currency: BigInt(currency as string).toString(),
      category: BigInt(category as string).toString(),
      merchantId: merchant as string,
      issuedAt: BigInt(now as string).toString(),
      cartHash: cart as string,
      agentId: BigInt(operator as string).toString(),
    },
    c1Proof: {
      proof: "",
      public_inputs: inputs,
      recursive_proof: Buffer.concat(c1.proof.map((f) => Buffer.from(f.slice(2), "hex"))).toString(
        "base64",
      ),
    },
  });
  return purchaseId;
}

describe("proveAnonymousPurchase", () => {
  test("composes the purchase's C1 with the mandate's C3 into one proof a merchant verifies", {
    timeout: 180_000,
  }, async () => {
    const c3 = await proveAnonymousMandate({ db: testDb, log }, id, salt);
    expect(c3.recursive_proof).toBeDefined();
    const purchaseId = await storePurchase(id);
    expect(await composable(testDb, purchaseId)).toBe(true);
    const composed = await proveAnonymousPurchase({ db: testDb, log }, purchaseId);
    const root = c3.public_inputs[2] as string;
    const row = await testDb.query.purchases.findFirst({
      where: (p, { eq }) => eq(p.id, purchaseId),
    });
    const countersign = row?.countersign as Parameters<typeof c1c3Statement>[0];
    expect(composed.public_inputs).toEqual(c1c3Statement(countersign, root));
    expect(await composable(testDb, purchaseId)).toBe(false);

    const res = await get(`/v1/anonymous-purchases/${purchaseId}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as Parameters<typeof verifyAnonymousPurchase>[0];
    const registered = async (r: string) => (await get(`/v1/user-set/roots/${r}`)).status === 200;
    expect(await verifyAnonymousPurchase(body, countersign, registered)).toBe(true);
    const other = { ...countersign, amount: "8501" };
    expect(await verifyAnonymousPurchase(body, other, registered)).toBe(false);
    const { x, y } = vector.mandate.user.cred.jwk;
    for (const secret of [x, y, userId, vector.publicKey]) expect(text).not.toContain(secret);
  });

  test("composes nothing for a purchase whose C1 is of another mandate", async () => {
    const inputs = [...c1.publicInputs];
    inputs[0] = hex32(1n);
    const purchaseId = await storePurchase(id, inputs);
    await expect(proveAnonymousPurchase({ db: testDb, log }, purchaseId)).rejects.toThrow(
      "other mandates",
    );
  });
});

describe("public reads", () => {
  test("a mandate without a proof and an unknown root are not found", async () => {
    expect((await get(`/v1/anonymous-mandates/0x${"ab".repeat(32)}`)).status).toBe(404);
    expect((await get(`/v1/user-set/roots/0x${"cd".repeat(32)}`)).status).toBe(404);
    expect((await get("/v1/user-set/roots/0x12")).status).toBe(422);
    expect((await get(`/v1/anonymous-purchases/${ulid()}`)).status).toBe(404);
  });

  test("records the root of the set a proof was made under", async () => {
    const rows = await testDb.select().from(userSetRoots);
    expect(rows.map((r) => r.size)).toContain(3);
  });
});
