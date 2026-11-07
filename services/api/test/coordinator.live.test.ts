import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, desc, eq, events, teeSignatures, teeSigners } from "@keelson/db";
import { pino } from "pino";
import { recoverAddress, zeroAddress } from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type Countersigned,
  type CountersignRequest,
  LegClient,
  LegError,
  ObservationSchema,
} from "../src/tee/client.ts";
import { createTee } from "../src/tee/config.ts";
import {
  type CoordinatorDeps,
  CoordinatorError,
  type CountersignExpectation,
  countersign2of2,
} from "../src/tee/coordinator.ts";
import { activeSigner, refreshLeg, type TeeConfig } from "../src/tee/signers.ts";
import { testDb, testKv } from "./setup.ts";
import {
  carts,
  expectation,
  live,
  liveEnv,
  registerMandate,
  request,
  VirtualPasskey,
} from "./tee-live.ts";

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
  const prepare = async (cart: (typeof carts)[keyof typeof carts] = carts.demo) => {
    const agent = await fresh();
    const req = await request(agent, cart);
    return { req, want: await expectation(agent, req) };
  };
  const drive = (d: CoordinatorDeps, p: Awaited<ReturnType<typeof prepare>>) =>
    countersign2of2(d, p.req, p.want);

  beforeAll(async () => {
    passkey = await VirtualPasskey.create();
    await refreshLeg(testDb, "a", tee);
    await refreshLeg(testDb, "b", tee);
  }, 120_000);
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
    const { req, want } = await prepare();
    const started = performance.now();
    const out = await countersign2of2(deps(), req, want);
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
    const out = await drive(deps(), await prepare(carts.bundle));
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
    const { req, want } = await prepare();
    const out = await countersign2of2(deps({ b: down }), req, want);
    expect(out.mode).toBe("degraded");
    expect(out.signatures.nitro).toBeNull();
    expect(out.signers.nitro).toBeNull();
    await expect.poll(() => alarms("tee.degraded", req.request_id)).toHaveLength(1);
    vectors.degraded = out;

    const again = await drive(deps(), await prepare());
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
    const out = await drive(deps({ b: slow }), await prepare());
    expect(out.mode).toBe("degraded");
    console.log(
      `degraded after a 1 ms leg b timeout: ${Math.round(performance.now() - started)} ms in total`,
    );
  });

  test("a black-holed leg b is given up on within its timeout", async () => {
    const hole = new LegClient(
      "b",
      "https://10.255.255.1",
      process.env.KEELSON_TEE_TOKEN as string,
      500,
    );
    const agent = await fresh();
    const first = await request(agent, carts.demo);
    const second = await request(agent, carts.demo);
    const out = await countersign2of2(deps({ b: hole }), first, await expectation(agent, first));
    expect(out.mode).toBe("degraded");

    const started = performance.now();
    await hole.countersign(second).catch(() => undefined);
    const spent = performance.now() - started;
    console.log(`leg b given up on after ${Math.round(spent)} ms`);
    expect(spent).toBeLessThan(1_000);
  });

  test("a cart that differs by one unit price on leg b is a divergence with no signature", async () => {
    const { req, want } = await prepare();
    const tampered = Object.create(tee.client.b) as LegClient;
    tampered.countersign = (r) => {
      const cart = structuredClone(r.cart) as { lines: { unit_minor: number }[] };
      for (const line of cart.lines) line.unit_minor += 1;
      return tee.client.b.countersign({ ...r, cart });
    };
    const err = await countersign2of2(deps({ b: tampered }), req, want).then(
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
    const { req, want } = await prepare();
    const tampered = Object.create(tee.client.b) as LegClient;
    tampered.countersign = (r) =>
      tee.client.b.countersign({
        ...r,
        observation: { ...(r.observation as object), budget_left_minor: 0 } as never,
      });
    const err = await countersign2of2(deps({ b: tampered }), req, want).then(
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
    const { req, want } = await prepare();
    const err = await countersign2of2(deps({ a: slow, b: spy }), req, want).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as CoordinatorError).slug).toBe("tee-unavailable");
    expect((err as CoordinatorError).status).toBe(503);
    expect(called).toBe(false);
  });

  const failure = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e,
    );
  const unsigned = async (requestId: string) =>
    expect(
      await testDb.select().from(teeSignatures).where(eq(teeSignatures.requestId, requestId)),
    ).toHaveLength(0);
  const b4xx = (): LegClient => {
    const bad = Object.create(tee.client.b) as LegClient;
    bad.countersign = (r) => tee.client.b.countersign({ ...r, closed_mandate: "x" });
    return bad;
  };
  const a2 = (answer: (r: CountersignRequest) => Promise<Countersigned>): LegClient => {
    const wrapped = Object.create(tee.client.a) as LegClient;
    wrapped.countersign = answer;
    return wrapped;
  };
  const hole = () =>
    new LegClient("b", "http://127.0.0.1:9", process.env.KEELSON_TEE_TOKEN as string, 500);

  test("a problem answer from leg b is a divergence, never a downgrade", async () => {
    const { req, want } = await prepare();
    const answered = await tee.client.b.countersign({ ...req, closed_mandate: "x" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((answered as LegError).kind).toBe("problem");
    expect((answered as LegError).status).toBeGreaterThanOrEqual(400);

    const err = await failure(countersign2of2(deps({ b: b4xx() }), req, want));
    expect((err as CoordinatorError).slug).toBe("tee-divergence");
    expect((err as CoordinatorError).status).toBe(502);
    await unsigned(req.request_id);
  });

  test("a 5xx problem body from leg b is a divergence too", async () => {
    const { req, want } = await prepare();
    const broken = Object.create(tee.client.b) as LegClient;
    broken.countersign = () => Promise.reject(new LegError("b", "problem", "internal", 503));
    const err = await failure(countersign2of2(deps({ b: broken }), req, want));
    expect((err as CoordinatorError).slug).toBe("tee-divergence");
    await unsigned(req.request_id);
  });

  test("a leg b whose signer went stale is skipped and the countersign is degraded", async () => {
    const b = await signerRow(2);
    await testDb
      .update(teeSigners)
      .set({ verifiedAt: new Date(Date.now() - 3 * 3_600_000) })
      .where(eq(teeSigners.address, b.address));
    try {
      const out = await drive(deps(), await prepare());
      expect(out.mode).toBe("degraded");
    } finally {
      await testDb
        .update(teeSigners)
        .set({ verifiedAt: b.verifiedAt })
        .where(eq(teeSigners.address, b.address));
    }
  });

  test("the observation is exactly the engine's, at every level", async () => {
    const out = await drive(deps(), await prepare());
    const seen = ObservationSchema.safeParse(out.observation);
    expect(seen.success, JSON.stringify(seen.error)).toBe(true);
    const o = out.observation as unknown as Record<string, Record<string, unknown>>;
    for (const extra of [
      { ...o, extra: 1 },
      { ...o, paypal: { ...o.paypal, extra: 1 } },
      { ...o, user_key: { ...o.user_key, extra: 1 } },
    ]) {
      expect(ObservationSchema.safeParse(extra).success).toBe(false);
    }
  });

  test("leg a failing to read PayPal is a retryable refusal of its own, with no signature", async () => {
    const { req, want } = await prepare();
    const paypal = a2(() => Promise.reject(new LegError("a", "problem", "paypal", 502)));
    const err = await failure(countersign2of2(deps({ a: paypal }), req, want));
    expect((err as CoordinatorError).slug).toBe("paypal-unavailable");
    expect((err as CoordinatorError).status).toBe(503);
    await unsigned(req.request_id);
  });

  test("a malformed answer from leg a is a divergence", async () => {
    const { req, want } = await prepare();
    const malformed = a2(() => Promise.reject(new LegError("a", "problem", "malformed_response")));
    const err = await failure(countersign2of2(deps({ a: malformed }), req, want));
    expect((err as CoordinatorError).slug).toBe("tee-divergence");
  });

  test("an answer to another request is refused even with leg b down", async () => {
    const earlier = await prepare();
    const first = await tee.client.a.countersign(earlier.req);
    const { req, want } = await prepare();
    const replay = a2(() => Promise.resolve(first));
    const err = await failure(countersign2of2(deps({ a: replay, b: hole() }), req, want));
    expect((err as CoordinatorError).slug).toBe("tee-divergence");
    await unsigned(req.request_id);
  });

  test("a countersign field that is not a number is a divergence, not a crash", async () => {
    const { req, want } = await prepare();
    const bad = a2(async (r) => {
      const answer = await tee.client.a.countersign(r);
      return { ...answer, countersign: { ...answer.countersign, agentId: "abc" } };
    });
    const err = await failure(countersign2of2(deps({ a: bad, b: hole() }), req, want));
    expect(err).toBeInstanceOf(CoordinatorError);
    expect((err as CoordinatorError).slug).toBe("tee-divergence");
  });

  test("a trace that does not hash to the evalHash is refused", async () => {
    const { req, want } = await prepare();
    const forged = a2(async (r) => ({
      ...(await tee.client.a.countersign(r)),
      trace_jcs: Buffer.from('{"decision":"allow"}').toString("base64"),
    }));
    const err = await failure(countersign2of2(deps({ a: forged, b: hole() }), req, want));
    expect((err as CoordinatorError).slug).toBe("tee-divergence");
    await unsigned(req.request_id);
  });

  test("a countersign that already expired is refused", async () => {
    const { req, want } = await prepare();
    const err = await failure(
      countersign2of2({ ...deps(), now: () => new Date(Date.now() + 3_600_000) }, req, want),
    );
    expect((err as CoordinatorError).slug).toBe("tee-divergence");
    await unsigned(req.request_id);
  });

  test("a countersign that disagrees with the stored purchase is a divergence", async () => {
    const { req, want } = await prepare();
    const wrong: CountersignExpectation[] = [
      { ...want, amount: want.amount + 1n },
      { ...want, cartHash: `0x${"11".repeat(32)}` },
      { ...want, merchantId: `0x${"22".repeat(32)}` },
      { ...want, currency: want.currency + 1 },
      { ...want, mandateHash: `0x${"33".repeat(32)}` },
    ];
    for (const w of wrong) {
      const err = await failure(countersign2of2(deps({ b: hole() }), req, w));
      expect((err as CoordinatorError).slug).toBe("tee-divergence");
    }
    await unsigned(req.request_id);
  });

  test("a refusal never names the leg", async () => {
    const down = new LegClient(
      "a",
      "http://127.0.0.1:9",
      process.env.KEELSON_TEE_TOKEN as string,
      500,
    );
    const { req, want } = await prepare();
    const err = await failure(countersign2of2(deps({ a: down }), req, want));
    expect((err as CoordinatorError).message).not.toMatch(/\bleg\b/i);
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

  // Leg A's signature alone, from the run with leg B unreachable above.
  test.skipIf(process.env.KEELSON_WRITE_VECTORS !== "1")("writes the degraded vector", async () => {
    const a = await signerRow(1);
    const file = fileURLToPath(
      new URL("../../../packages/core/test/vectors/countersign-degraded.json", import.meta.url),
    );
    const { observation: _o, ...degraded } = vectors.degraded as Record<string, unknown>;
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
          degraded,
          attestations: { tdx: a.attestation },
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

  test("a signature from a signer other than the registered one is rejected", async () => {
    const a = await signerRow(1);
    const other = Buffer.alloc(20, 7);
    await testDb
      .update(teeSigners)
      .set({ address: other })
      .where(eq(teeSigners.address, a.address));
    try {
      const err = await drive(deps(), await prepare()).then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as CoordinatorError).slug).toBe("tee-unregistered-signer");
    } finally {
      await testDb
        .update(teeSigners)
        .set({ address: a.address })
        .where(eq(teeSigners.address, other));
    }
    expect((await activeSigner(testDb, 1))?.address).toBeDefined();
  });

  // Last: the revoked signer is the live leg's own and cannot be admitted again.
  test("a signer that signed another digest for the request is revoked", async () => {
    const { req, want } = await prepare();
    const a = await signerRow(1);
    await testDb.insert(teeSignatures).values({
      requestId: req.request_id,
      signer: a.address,
      digest: Buffer.alloc(32, 7),
      signature: Buffer.alloc(65, 7),
    });
    const err = await countersign2of2(deps(), req, want).then(
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
