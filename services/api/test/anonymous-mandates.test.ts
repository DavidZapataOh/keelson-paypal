import "../src/tee/attest.ts";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { c3Statement, verifyC3 } from "@keelson/alibi/verify";
import { mandates, operators, passkey, user, userSetRoots } from "@keelson/db";
import { hSd, mandateChallenge } from "@keelson/mandate";
import { pino } from "pino";
import { ulid } from "ulid";
import { beforeAll, describe, expect, test } from "vitest";
import vector from "../../../packages/mandate/test/vectors/c3.json" with { type: "json" };
import { createApp } from "../src/app.ts";
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

describe("public reads", () => {
  test("a mandate without a proof and an unknown root are not found", async () => {
    expect((await get(`/v1/anonymous-mandates/0x${"ab".repeat(32)}`)).status).toBe(404);
    expect((await get(`/v1/user-set/roots/0x${"cd".repeat(32)}`)).status).toBe(404);
    expect((await get("/v1/user-set/roots/0x12")).status).toBe(422);
  });

  test("records the root of the set a proof was made under", async () => {
    const rows = await testDb.select().from(userSetRoots);
    expect(rows.map((r) => r.size)).toContain(3);
  });
});
