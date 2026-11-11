import { randomBytes } from "node:crypto";
import { disputes, type EngineProof, eq, mandates, operators, purchases, user } from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import { beforeAll, describe, expect, test } from "vitest";
import vector from "../../../engine/tee/tests/vectors/countersign-allow.json" with { type: "json" };
import { createApp } from "../src/app.ts";
import { ENGINE_RESUMES, engineInputOf, sweepEngineProofs } from "../src/zk/engine.ts";
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

describe("engine proof sweep", () => {
  const now = new Date();
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
  const { chain_id, verifier, tx, gas_used, proven_at, ...proved } = proof;

  async function stalled(set: Partial<typeof purchases.$inferInsert>): Promise<string> {
    const id = ulid();
    await storePurchase(id, `0x${randomBytes(32).toString("hex")}`);
    await testDb.update(purchases).set(set).where(eq(purchases.id, id));
    return id;
  }

  async function sweep(at = now, start?: (purchaseId: string) => Promise<void>) {
    const started: { purchaseId: string; key: string }[] = [];
    const result = await sweepEngineProofs(
      {
        db: testDb,
        log,
        start: async (purchaseId, key) => {
          await start?.(purchaseId);
          started.push({ purchaseId, key });
        },
      },
      at,
    );
    return { ...result, started: started.map((s) => s.purchaseId), keys: started };
  }

  test("resumes a stored request whose run is gone, by waiting for it", async () => {
    const id = await stalled({
      engineRequest: `0x${"ab".repeat(32)}`,
      engineAttemptedAt: minutesAgo(61),
    });
    const { resumed, started, keys } = await sweep();
    expect(resumed).toContain(id);
    expect(started).toContain(id);
    expect(keys.find((k) => k.purchaseId === id)?.key).toMatch(new RegExp(`^proveEngine:${id}:`));
  });

  test("resumes a paid proof that was never recorded", async () => {
    const id = await stalled({ engineProved: proved, engineAttemptedAt: minutesAgo(90) });
    expect((await sweep()).started).toContain(id);
  });

  test("leaves a run that may still hold the purchase, and a recorded proof", async () => {
    const running = await stalled({
      engineRequest: `0x${"cd".repeat(32)}`,
      engineAttemptedAt: minutesAgo(30),
    });
    const recorded = await stalled({
      engineRequest: `0x${"ef".repeat(32)}`,
      engineProved: proved,
      engineProof: proof,
      engineAttemptedAt: minutesAgo(600),
    });
    const { started } = await sweep();
    expect(started).not.toContain(running);
    expect(started).not.toContain(recorded);
  });

  test("never requests again for a bare claim, and flags one older than the request window", async () => {
    const stuck = await stalled({ engineRequest: "requesting", engineAttemptedAt: minutesAgo(20) });
    const fresh = await stalled({ engineRequest: "requesting", engineAttemptedAt: minutesAgo(2) });
    const result = await sweep();
    expect(result.started).not.toContain(stuck);
    expect(result.started).not.toContain(fresh);
    expect(result.stuck).toContain(stuck);
    expect(result.stuck).not.toContain(fresh);
    const [row] = await testDb
      .select({ request: purchases.engineRequest })
      .from(purchases)
      .where(eq(purchases.id, stuck));
    expect(row?.request).toBe("requesting");
  });

  test("leaves a run until its hour is over, and resumes a request no run ever marked", async () => {
    const recent = await stalled({
      engineRequest: `0x${"12".repeat(32)}`,
      engineAttemptedAt: minutesAgo(59),
    });
    const unmarked = await stalled({ engineRequest: `0x${"34".repeat(32)}` });
    const { started } = await sweep();
    expect(started).not.toContain(recent);
    expect(started).toContain(unmarked);
  });

  test("starts a resumed run once, under a key of its own, until it is given up", async () => {
    const id = await stalled({
      engineRequest: `0x${"56".repeat(32)}`,
      engineAttemptedAt: minutesAgo(61),
    });
    const keys: string[] = [];
    let at = now;
    for (let i = 0; i < ENGINE_RESUMES; i++) {
      const { keys: started } = await sweep(at);
      const key = started.find((k) => k.purchaseId === id)?.key;
      if (key) keys.push(key);
      // The started run dies at once; the next sweep comes five minutes later, then an hour later.
      const soon = await sweep(new Date(at.getTime() + 5 * 60_000));
      expect(soon.started).not.toContain(id);
      at = new Date(at.getTime() + 61 * 60_000);
    }
    expect(keys).toHaveLength(ENGINE_RESUMES);
    expect(new Set(keys).size).toBe(ENGINE_RESUMES);
    const last = await sweep(at);
    expect(last.started).not.toContain(id);
    expect(last.abandoned).toContain(id);
    // Given up on once: the error is not repeated on every sweep.
    expect((await sweep(new Date(at.getTime() + 5 * 60_000))).abandoned).not.toContain(id);
  });

  test("tries a run again when Render did not start it", async () => {
    const id = await stalled({
      engineRequest: `0x${"78".repeat(32)}`,
      engineAttemptedAt: minutesAgo(61),
    });
    await sweep(now, async (purchaseId) => {
      if (purchaseId === id) throw new Error("render is down");
    });
    expect((await sweep()).started).toContain(id);
  });

  test("never flags a claim whose proof was paid for or recorded", async () => {
    const paid = await stalled({
      engineRequest: "requesting",
      engineProved: proved,
      engineAttemptedAt: minutesAgo(20),
    });
    expect((await sweep()).stuck).not.toContain(paid);
  });

  test("is failed for a bare claim, and for a proof given up on", async () => {
    const claim = await stalled({ engineRequest: "requesting", engineAttemptedAt: minutesAgo(90) });
    const givenUp = await stalled({
      engineRequest: `0x${"9a".repeat(32)}`,
      engineResumes: ENGINE_RESUMES,
    });
    for (const purchaseId of [claim, givenUp]) {
      await testDb.insert(disputes).values({
        id: `PP-D-${randomBytes(4).toString("hex")}`,
        purchaseId,
        reason: "UNAUTHORISED",
        raw: {},
        createdAt: new Date(Date.now() - 8 * 3_600_000),
      });
      const body = (await (await app.request(`/v1/engine-proofs/${purchaseId}`)).json()) as {
        status: string;
      };
      expect(body.status).toBe("failed");
    }
  });

  test("keeps a disputed purchase proving while its proof can still be resumed", async () => {
    await testDb
      .update(purchases)
      .set({ engineProof: null, engineRequest: `0x${"ab".repeat(32)}` })
      .where(eq(purchases.id, disputed));
    await testDb
      .update(disputes)
      .set({ createdAt: new Date(Date.now() - 8 * 3_600_000) })
      .where(eq(disputes.purchaseId, disputed));
    const body = (await (await app.request(`/v1/engine-proofs/${disputed}`)).json()) as {
      status: string;
    };
    expect(body.status).toBe("proving");
  });
});
