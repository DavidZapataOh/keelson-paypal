import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, desc, eq, events, teeSignatures, teeSigners } from "@keelson/db";
import { pino } from "pino";
import { recoverAddress, zeroAddress } from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LegClient, LegError } from "../src/tee/client.ts";
import { createTee } from "../src/tee/config.ts";
import { type CoordinatorDeps, CoordinatorError, countersign2of2 } from "../src/tee/coordinator.ts";
import { activeSigner, registerLeg, type TeeConfig } from "../src/tee/signers.ts";
import { testDb, testKv } from "./setup.ts";
import { carts, live, liveEnv, registerMandate, request, VirtualPasskey } from "./tee-live.ts";

// The legs are reached from a laptop here, not from the API's region.
const SLOW = { a: 10_000, b: 10_000 };

describe.skipIf(!live)("coordinator (live legs)", { timeout: 120_000 }, () => {
  const tee = createTee(liveEnv(), SLOW);
  const deps = (over: Partial<TeeConfig["client"]> = {}): CoordinatorDeps => ({
    db: testDb,
    kv: testKv,
    log: pino({ level: "silent" }),
    tee: { ...tee, client: { ...tee.client, ...over } },
    verifyingContract: zeroAddress,
  });
  let passkey: VirtualPasskey;
  const fresh = () => registerMandate(tee.client.a, passkey);

  beforeAll(async () => {
    passkey = await VirtualPasskey.create();
    await registerLeg(testDb, "a", tee.client.a, tee.expect.a);
    await registerLeg(testDb, "b", tee.client.b, tee.expect.b);
  });
  afterAll(async () => {
    await passkey.close();
  });

  const alarms = async (type: string, requestId: string) =>
    (await testDb.select().from(events)).filter(
      (e) =>
        e.channel === "public:tee" &&
        e.subjectId === requestId &&
        (e.payload as { type: string }).type === type,
    );

  const vectors: Record<string, unknown> = {};

  test("the demo cart is allowed by both legs", async () => {
    const agent = await fresh();
    const req = await request(agent, carts.demo);
    const started = performance.now();
    const out = await countersign2of2(deps(), req);
    console.log(
      `2of2 countersign from the test host: ${Math.round(performance.now() - started)} ms`,
    );

    expect(out.mode).toBe("2of2");
    expect(out.countersign.decision).toBe("1");
    const a = await activeSigner(testDb, 1);
    const b = await activeSigner(testDb, 2);
    expect(await recoverAddress({ hash: out.digest, signature: out.signatures.tdx })).toBe(
      a?.address,
    );
    expect(
      await recoverAddress({ hash: out.digest, signature: out.signatures.nitro as `0x${string}` }),
    ).toBe(b?.address);
    const rows = await testDb
      .select()
      .from(teeSignatures)
      .where(eq(teeSignatures.requestId, req.request_id));
    expect(rows).toHaveLength(2);
    vectors.allow = out;
  });

  test("a $340 bundle is a countersigned deny on both legs", async () => {
    const out = await countersign2of2(deps(), await request(await fresh(), carts.bundle));
    expect(out.mode).toBe("2of2");
    expect(out.countersign.decision).toBe("2");
    expect(out.signatures.nitro).not.toBeNull();
    vectors.deny = out;
  });

  test("leg b unreachable gives a degraded countersign and an event", async () => {
    const down = new LegClient(
      "b",
      "http://127.0.0.1:9",
      process.env.KEELSON_TEE_TOKEN as string,
      500,
    );
    const req = await request(await fresh(), carts.demo);
    const out = await countersign2of2(deps({ b: down }), req);
    expect(out.mode).toBe("degraded");
    expect(out.signatures.nitro).toBeNull();
    expect(out.signers.nitro).toBeNull();
    await expect.poll(() => alarms("tee.degraded", req.request_id)).toHaveLength(1);

    const again = await countersign2of2(deps(), await request(await fresh(), carts.demo));
    expect(again.mode).toBe("2of2");
  });

  test("leg b answering after the timeout is treated as down", async () => {
    const slow = new LegClient(
      "b",
      process.env.TEE_B_URL as string,
      process.env.KEELSON_TEE_TOKEN as string,
      1,
    );
    const started = performance.now();
    const out = await countersign2of2(deps({ b: slow }), await request(await fresh(), carts.demo));
    expect(out.mode).toBe("degraded");
    console.log(
      `degraded after a 1 ms leg b timeout: ${Math.round(performance.now() - started)} ms in total`,
    );
  });

  test("a cart that differs by one unit price on leg b is a divergence with no signature", async () => {
    const req = await request(await fresh(), carts.demo);
    const tampered = Object.create(tee.client.b) as LegClient;
    tampered.countersign = (r) => {
      const cart = structuredClone(r.cart) as { lines: { unit_minor: number }[] };
      for (const line of cart.lines) line.unit_minor += 1;
      return tee.client.b.countersign({ ...r, cart });
    };
    const err = await countersign2of2(deps({ b: tampered }), req).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CoordinatorError);
    expect((err as CoordinatorError).slug).toBe("tee-divergence");
    expect(JSON.stringify(err)).not.toMatch(/0x[0-9a-f]{130}/);
    await expect.poll(() => alarms("tee.divergence", req.request_id)).toHaveLength(1);
    expect(
      await testDb.select().from(teeSignatures).where(eq(teeSignatures.requestId, req.request_id)),
    ).toHaveLength(0);
  });

  test("an observation altered on its way to leg b makes the digests differ", async () => {
    const req = await request(await fresh(), carts.demo);
    const tampered = Object.create(tee.client.b) as LegClient;
    tampered.countersign = (r) =>
      tee.client.b.countersign({
        ...r,
        observation: { ...(r.observation as object), budget_left_minor: 0 } as never,
      });
    const err = await countersign2of2(deps({ b: tampered }), req).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as CoordinatorError).slug).toBe("tee-divergence");
    expect(
      await testDb.select().from(teeSignatures).where(eq(teeSignatures.requestId, req.request_id)),
    ).toHaveLength(0);
  });

  test("leg a timing out signs nothing and never calls leg b", async () => {
    const slow = new LegClient(
      "a",
      "https://10.255.255.1",
      process.env.KEELSON_TEE_TOKEN as string,
      1_500,
    );
    let called = false;
    const spy = Object.create(tee.client.b) as LegClient;
    spy.countersign = (r) => {
      called = true;
      return tee.client.b.countersign(r);
    };
    const req = await request(await fresh(), carts.demo);
    const err = await countersign2of2(deps({ a: slow, b: spy }), req).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as CoordinatorError).slug).toBe("tee-unavailable");
    expect((err as CoordinatorError).status).toBe(503);
    expect(called).toBe(false);
  });

  // The signatures of the two runs above, for tests of the on-chain verifier. Set
  // KEELSON_WRITE_VECTORS=1 to refresh the file.
  test.skipIf(process.env.KEELSON_WRITE_VECTORS !== "1")("writes the 2-of-2 vectors", async () => {
    const [a, b] = await Promise.all([signerRow(1), signerRow(2)]);
    const file = fileURLToPath(
      new URL("../../../packages/core/test/vectors/countersign-2of2.json", import.meta.url),
    );
    const { mode: _a, observation: _oa, ...allow } = vectors.allow as Record<string, unknown>;
    const { mode: _d, observation: _od, ...deny } = vectors.deny as Record<string, unknown>;
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          domain: {
            name: "Keelson",
            version: "1",
            chainId: 421614,
            verifyingContract: zeroAddress,
          },
          capturedAt: new Date().toISOString(),
          allow,
          deny,
          attestations: { tdx: a.attestation, nitro: b.attestation },
        },
        null,
        2,
      )}\n`,
    );
  });

  const signerRow = async (kind: 1 | 2) => {
    const [row] = await testDb
      .select()
      .from(teeSigners)
      .where(and(eq(teeSigners.teeKind, kind)));
    if (!row) throw new Error(`no signer of kind ${kind}`);
    return row;
  };

  test("a signer registered for the other leg is rejected", async () => {
    const a = await signerRow(1);
    const b = await signerRow(2);
    await testDb.transaction(async (tx) => {
      await tx.update(teeSigners).set({ teeKind: 2 }).where(eq(teeSigners.address, a.address));
      await tx.update(teeSigners).set({ teeKind: 1 }).where(eq(teeSigners.address, b.address));
    });
    try {
      const err = await countersign2of2(deps(), await request(await fresh(), carts.demo)).then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as CoordinatorError).slug).toBe("tee-unregistered-signer");
    } finally {
      await testDb.transaction(async (tx) => {
        await tx.update(teeSigners).set({ teeKind: 1 }).where(eq(teeSigners.address, a.address));
        await tx.update(teeSigners).set({ teeKind: 2 }).where(eq(teeSigners.address, b.address));
      });
    }
    expect((await activeSigner(testDb, 1))?.address).toBeDefined();
  });

  // Last: the revoked signer is the live leg's own and cannot be admitted again.
  test("a signer that signed another digest for the request is revoked", async () => {
    const req = await request(await fresh(), carts.demo);
    const a = await signerRow(1);
    await testDb.insert(teeSignatures).values({
      requestId: req.request_id,
      signer: a.address,
      digest: Buffer.alloc(32, 7),
      signature: Buffer.alloc(65, 7),
    });
    const err = await countersign2of2(deps(), req).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as CoordinatorError).slug).toBe("tee-contradiction");
    expect(await activeSigner(testDb, 1)).toBeNull();
    await expect.poll(() => alarms("tee.contradiction", req.request_id)).toHaveLength(1);
    const alarm = (await alarms("tee.contradiction", req.request_id))[0];
    expect(alarm).toBeDefined();
    expect((alarm as { payload: { digests: unknown[] } }).payload.digests).toHaveLength(2);
    const [row] = await testDb
      .select()
      .from(teeSigners)
      .where(eq(teeSigners.revokedReason, "contradiction"))
      .orderBy(desc(teeSigners.registeredAt));
    expect(row).toBeDefined();
    expect(LegError).toBeDefined();
  });
});
