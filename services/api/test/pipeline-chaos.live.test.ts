import { createServer } from "node:net";
import { cartHash, ulidToBytes32 } from "@keelson/core";
import { chainTxs, eq, purchases } from "@keelson/db";
import { closeMandate } from "@keelson/mandate";
import { pino } from "pino";
import { ulid } from "ulid";
import { bytesToHex, createPublicClient, http, type PublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { createTee } from "../src/tee/config.ts";
import { refreshLeg } from "../src/tee/signers.ts";
import { ApiProcess } from "./api-process.ts";
import { EvidenceUploader } from "./evidence.ts";
import { holdHarness, sandbox } from "./hold-live.ts";
import { checkBudget, checkInvariants } from "./invariants.ts";
import { type LocalLog, startLocalLog } from "./log-live.ts";
import { cartOf, demoOperator, seedDemoOperator } from "./pipeline-live.ts";
import { testDb, testDbUrl, testKv } from "./setup.ts";
import { asAgent, headerPrincipal, live, liveEnv } from "./tee-live.ts";

const keys = live && process.env.RELAYER_AWS_ACCESS_KEY_ID && process.env.KEELSON_OPERATOR_KEY;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise<number>((done) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });

describe.skipIf(!keys)(
  "killing the API at every step of a purchase (live)",
  { timeout: 3_600_000 },
  () => {
    const log = pino({ level: "silent" });
    const paypal = sandbox();
    const chain = createPublicClient({
      chain: arbitrumSepolia,
      transport: http(process.env.ARBITRUM_SEPOLIA_RPC_URL),
    }) as PublicClient;
    const tee = createTee(liveEnv(), { a: 10_000, b: 10_000 });
    const app = createApp({
      db: testDb,
      kv: testKv,
      log,
      appOrigin: "https://app.keelson.finance",
      authenticate: headerPrincipal,
      tee,
      paypal,
    });
    const evidence = new EvidenceUploader();
    let tlog: LocalLog;
    let api: ApiProcess;
    let other: ApiProcess;
    let mandate: Awaited<ReturnType<ReturnType<typeof holdHarness>["signed"]>> & {
      authorizationId: string;
    };
    const driven: string[] = [];
    const kills: { point: string; resumeMs: number }[] = [];

    const env = () => ({
      DATABASE_URL: testDbUrl,
      TEST_TLOG: JSON.stringify({ url: tlog.url, token: tlog.token, vkeys: tlog.vkeys }),
    });

    beforeAll(async () => {
      tlog = await startLocalLog(testDbUrl);
      await seedDemoOperator(testDb);
      await refreshLeg(testDb, "a", tee);
      await refreshLeg(testDb, "b", tee);
      api = new ApiProcess(await freePort(), env());
      other = new ApiProcess(await freePort(), env());
      await Promise.all([api.start(), other.start()]);
      const h = holdHarness(app, paypal);
      const s = await h.signed((m) => {
        m.payment.constraints = m.payment.constraints.map((c) =>
          c.type === "payment.budget" || c.type === "payment.amount_range"
            ? { ...c, max: 3_000 }
            : c,
        );
      }, demoOperator);
      mandate = { ...s, ...(await h.activate(s.sub, s.mid)) };
    }, 600_000);

    afterAll(async () => {
      await api?.kill();
      await other?.kill();
      await holdHarness(app, paypal).release(mandate?.authorizationId);
      await tlog?.stop();
      await evidence.close();
    });

    /** A countersign request for $1, ready to post to either process. */
    async function request(requestId = ulid()) {
      const cart = cartOf(100);
      const body = JSON.stringify({
        authorizationId: mandate.authorizationId,
        closedMandate: await closeMandate(
          mandate.openMandate,
          { requestId, cartHash: `sha256:${bytesToHex(cartHash(cart.cart)).slice(2)}` },
          mandate.agentKey,
        ),
        cart: cart.cart,
        unit: cart.unit,
        evidenceRoot: await evidence.upload(app, mandate.mid, cart.cart, asAgent),
      });
      driven.push(requestId);
      return {
        requestId,
        post: (to: ApiProcess) =>
          fetch(`${to.url}/v1/countersign`, {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": ulid(), ...asAgent },
            body,
          }).then(
            (r) => r.status,
            () => 0,
          ),
      };
    }

    const state = async (id: string) =>
      (
        await testDb.select({ state: purchases.state }).from(purchases).where(eq(purchases.id, id))
      )[0]?.state;

    async function until(check: () => Promise<boolean>, ms = 120_000) {
      const deadline = Date.now() + ms;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error("timed out");
        await sleep(5);
      }
    }

    const terminal = (id: string) => async () =>
      ["CAPTURED", "FAILED", "DENIED"].includes((await state(id)) ?? "");

    const points: [string, (id: string) => Promise<void>][] = [
      ["after COUNTERSIGNED", (id) => until(async () => (await state(id)) === "COUNTERSIGNED")],
      ["after LOGGED", (id) => until(async () => (await state(id)) === "LOGGED")],
      [
        "while the coverage is pending",
        (id) =>
          until(async () => {
            const [tx] = await testDb
              .select({ status: chainTxs.status })
              .from(chainTxs)
              .where(eq(chainTxs.key, `KeelsonBondVault.lockCoverage:${ulidToBytes32(id)}`));
            return tx !== undefined;
          }),
      ],
      ["after COVERED", (id) => until(async () => (await state(id)) === "COVERED")],
      ["right after the capture is sent", () => api.line('"msg":"capture.sent"')],
    ];

    test.each(points)(
      "killed %s, the restarted API finishes it and money moves once",
      async (point, at) => {
        const r = await request();
        const posted = r.post(api);
        await at(r.requestId);
        await api.kill();
        await posted;
        const killedAt = Date.now();
        await api.start();
        await until(terminal(r.requestId), 120_000);
        kills.push({ point, resumeMs: Date.now() - killedAt });
        console.info(`${point}: ${await state(r.requestId)} after ${Date.now() - killedAt} ms`);
        await checkInvariants({ db: testDb, paypal, chain }, r.requestId);
        expect(await state(r.requestId)).toBe("CAPTURED");
      },
    );

    test("purchases at two processes at once, and one request posted to both, capture once each", async () => {
      const many = await Promise.all(Array.from({ length: 6 }, () => request()));
      const twice = await request();
      await Promise.all([
        ...many.map((r, i) => r.post(i % 2 === 0 ? api : other)),
        ...Array.from({ length: 3 }, (_, i) => twice.post(i % 2 === 0 ? api : other)),
      ]);
      for (const r of [...many, twice]) {
        await until(terminal(r.requestId), 180_000);
        await checkInvariants({ db: testDb, paypal, chain }, r.requestId);
      }
      await checkBudget({ db: testDb, paypal }, mandate.mid);
    });

    test("a purchase killed after COVERED and down past its capture window fails with nothing captured", async () => {
      const windowed = new ApiProcess(await freePort(), { ...env(), CAPTURE_WINDOW_SEC: "30" });
      await windowed.start();
      const r = await request();
      const posted = r.post(windowed);
      await until(async () => (await state(r.requestId)) === "COVERED");
      await windowed.kill();
      await api.kill();
      await other.kill();
      await posted;
      await sleep(31_000);
      await windowed.start();
      await until(terminal(r.requestId), 120_000);
      await windowed.kill();
      await checkInvariants({ db: testDb, paypal, chain }, r.requestId);
      const [p] = await testDb.select().from(purchases).where(eq(purchases.id, r.requestId));
      // The capture may have reached PayPal before the kill; then it was adopted, never repeated.
      if (p?.state === "FAILED") expect(p.failureReason).toBe("capture:window-closed");
      await checkBudget({ db: testDb, paypal }, mandate.mid);
      console.info(JSON.stringify(kills));
    });
  },
);
