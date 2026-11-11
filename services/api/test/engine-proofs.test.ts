import { randomBytes } from "node:crypto";
import { disputes, type EngineProof, eq, mandates, operators, purchases, user } from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import { beforeAll, describe, expect, test } from "vitest";
import vector from "../../../engine/tee/tests/vectors/countersign-allow.json" with { type: "json" };
import { createApp } from "../src/app.ts";
import { engineInputOf } from "../src/zk/engine.ts";
import { testDb, testKv } from "./setup.ts";

const log = pino({ level: "silent" });
const app = createApp({ db: testDb, kv: testKv, log });

const { input } = vector;
const userId = `user-${randomBytes(6).toString("hex")}`;
const agentId = BigInt(input.payload_sd.agent.operator.agent_id);
const mandateId = ulid();
const disputed = ulid();
const undisputed = ulid();

const proof: EngineProof = {
  vkey: `0x${"11".repeat(32)}`,
  public_values: `0x${vector.eval_hash.slice(2)}${vector.digest.slice(2)}`,
  proof: "0xa4594c59",
  eval_hash: vector.eval_hash,
  countersign_digest: vector.digest,
  cycles: 40_000_000,
  prove_ms: 300_000,
  proof_bytes: 260,
  sp1_version: "v6.1.0",
  chain_id: 421614,
  verifier: `0x${"22".repeat(20)}`,
  tx: `0x${"33".repeat(32)}`,
  gas_used: "280000",
  proven_at: new Date().toISOString(),
};

async function storePurchase(id: string, digest = vector.digest) {
  await testDb.insert(purchases).values({
    id,
    mandateId,
    merchantId: input.cart.merchant,
    currency: input.cart.currency,
    amountMinor: 9400n,
    cartHash: randomBytes(32),
    countersignDigest: Buffer.from(digest.slice(2), "hex"),
    countersign: {
      requestId: input.request_id,
      evidenceRoot: input.evidence_root,
      expiresAt: String(input.expires_at),
      evalHash: vector.eval_hash,
    },
    evalTrace: { engine: { oci_digest: input.oci_digest, canonicalizer: input.canonicalizer } },
    engineInput: {
      cart: input.cart,
      unit: input.unit,
      evidence: input.evidence,
      now_ms: input.now_ms,
      budget_left_minor: input.budget_left_minor,
      chain_id: input.chain_id,
      verifying_contract: input.verifying_contract,
    },
  });
}

beforeAll(async () => {
  await testDb.insert(user).values({ id: userId, name: "Tester", email: `${userId}@example.test` });
  await testDb
    .insert(operators)
    .values({
      agentId,
      chainId: 421614,
      agentRegistry: input.payload_sd.agent.operator.agent_registry,
      name: "op",
      cnfJwk: {},
    })
    .onConflictDoNothing();
  await testDb.insert(mandates).values({
    id: mandateId,
    userId,
    operatorAgentId: agentId,
    state: "SIGNED",
    currency: "USD",
    maxMinor: 10_000n,
    remainingMinor: 10_000n,
    merchantIds: [input.cart.merchant],
    expiresAt: new Date(input.expires_at * 1000),
    payloadSd: input.payload_sd,
    disclosures: input.disclosures,
  });
  await storePurchase(disputed);
  await storePurchase(undisputed, `0x${randomBytes(32).toString("hex")}`);
  await testDb.insert(disputes).values({
    id: `PP-D-${randomBytes(4).toString("hex")}`,
    purchaseId: disputed,
    reason: "UNAUTHORISED",
    raw: {},
  });
});

describe("engine input", () => {
  test("is the countersign input the engine's own recomputation reads", async () => {
    const got = await engineInputOf(testDb, disputed);
    expect(got.input).toEqual(input);
    expect(got.evalHash).toBe(vector.eval_hash);
    expect(got.digest).toBe(vector.digest);
  });

  test("is missing for a purchase countersigned without it", async () => {
    await expect(engineInputOf(testDb, ulid())).rejects.toBeInstanceOf(RangeError);
  });
});

describe("GET /v1/engine-proofs/{id}", () => {
  test("is proving for a disputed purchase without a proof", async () => {
    const res = await app.request(`/v1/engine-proofs/${disputed}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; proof: unknown };
    expect(body).toMatchObject({
      status: "proving",
      countersign_eval_hash: vector.eval_hash,
      countersign_digest: vector.digest,
      proof: null,
    });
  });

  test("serves a recorded proof and whether it matches the countersign", async () => {
    await testDb.update(purchases).set({ engineProof: proof }).where(eq(purchases.id, disputed));
    const res = await app.request(`/v1/engine-proofs/${disputed}`);
    const body = (await res.json()) as { status: string; proof: Record<string, unknown> };
    expect(body.status).toBe("proven");
    expect(body.proof).toMatchObject({
      eval_hash: vector.eval_hash,
      matches: true,
      verifier: { chain_id: 421614, address: proof.verifier },
      explorer_url: `https://sepolia.arbiscan.io/tx/${proof.tx}`,
    });

    await testDb
      .update(purchases)
      .set({ engineProof: { ...proof, eval_hash: `0x${"44".repeat(32)}` } })
      .where(eq(purchases.id, disputed));
    const changed = (await (await app.request(`/v1/engine-proofs/${disputed}`)).json()) as {
      proof: { matches: boolean };
    };
    expect(changed.proof.matches).toBe(false);
  });

  test("is failed once the workflow's time has passed without a proof", async () => {
    await testDb.insert(disputes).values({
      id: `PP-D-${randomBytes(4).toString("hex")}`,
      purchaseId: undisputed,
      reason: "UNAUTHORISED",
      raw: {},
      createdAt: new Date(Date.now() - 8 * 3_600_000),
    });
    const body = (await (await app.request(`/v1/engine-proofs/${undisputed}`)).json()) as {
      status: string;
    };
    expect(body.status).toBe("failed");
    await testDb.delete(disputes).where(eq(disputes.purchaseId, undisputed));
  });

  test("is 404 for an undisputed purchase and an unknown one", async () => {
    expect((await app.request(`/v1/engine-proofs/${undisputed}`)).status).toBe(404);
    expect((await app.request(`/v1/engine-proofs/${ulid()}`)).status).toBe(404);
  });
});
