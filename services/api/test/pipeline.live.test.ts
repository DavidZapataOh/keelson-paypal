import { readFileSync } from "node:fs";
import { KMSClient } from "@aws-sdk/client-kms";
import { addresses, keelsonBondVaultAbi } from "@keelson/chain";
import { cartHash, ulidToBytes32 } from "@keelson/core";
import { eq, events, mandates, operators, purchases } from "@keelson/db";
import { closeMandate } from "@keelson/mandate";
import { ids } from "@keelson/paypal";
import { createRelayer, kmsAccount, type Relayer } from "@keelson/relayer";
import { pino } from "pino";
import { ulid } from "ulid";
import { type Address, bytesToHex, createPublicClient, type Hex, type PublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { ARBITRUM_SEPOLIA_PUBLIC_RPC, arbitrumSepoliaTransport } from "../src/chain/rpc.ts";
import { operatorSigners } from "../src/operators/signer.ts";
import { call, type PayPalDeps } from "../src/paypal.ts";
import {
  captureStep,
  findCapture,
  invoiceFor,
  reconcileCapture,
} from "../src/pipeline/capture-step.ts";
import { drivePurchase, type PipelineDeps } from "../src/pipeline/drive.ts";
import { logStep } from "../src/pipeline/log-step.ts";
import { principalChannel } from "../src/principal.ts";
import { createTee } from "../src/tee/config.ts";
import { refreshLeg } from "../src/tee/signers.ts";
import { EvidenceUploader } from "./evidence.ts";
import { holdHarness, row, sandbox } from "./hold-live.ts";
import { type LocalLog, startLocalLog } from "./log-live.ts";
import { testDb, testDbUrl, testKv } from "./setup.ts";
import {
  AGENT_CLIENT,
  asAgent,
  carts,
  headerPrincipal,
  live,
  liveEnv,
  repeating,
  testAgent,
} from "./tee-live.ts";

const registry = JSON.parse(
  readFileSync(new URL("../../../contracts/deployments/421614.json", import.meta.url), "utf8"),
) as { demo: { agentId: number } };
const AGENT_ID = BigInt(registry.demo.agentId);
const VAULT = addresses[421614].KeelsonBondVault as Address;
const keys = live && process.env.RELAYER_AWS_ACCESS_KEY_ID && process.env.KEELSON_OPERATOR_KEY;

/** The demo cart at another price. */
const cartOf = (minor: number) => {
  const value = (minor / 100).toFixed(2);
  return {
    cart: {
      ...carts.demo.cart,
      lines: carts.demo.cart.lines.map((l) => ({ ...l, unit_minor: minor })),
    },
    unit: {
      amount: {
        currency_code: "USD",
        value,
        breakdown: { item_total: { currency_code: "USD", value } },
      },
    },
  };
};

describe.skipIf(!keys)(
  "a purchase from countersign to capture (live)",
  { timeout: 1_800_000 },
  () => {
    const tee = createTee(liveEnv(), { a: 10_000, b: 10_000 });
    const log = pino({ level: "silent" });
    const paypal = keys ? sandbox() : (undefined as unknown as PayPalDeps);
    /** The next countersigns go to an API process that cannot reach PayPal, so they stop at COVERED. */
    const failNext = { left: 0 };
    const evidence = new EvidenceUploader();
    const client = createPublicClient({
      chain: arbitrumSepolia,
      transport: arbitrumSepoliaTransport(process.env.ARBITRUM_SEPOLIA_RPC_URL),
    }) as PublicClient;
    let tlog: LocalLog;
    let relayer: Relayer;
    let deps: PipelineDeps;
    let app: ReturnType<typeof createApp>;
    let uncaptured: ReturnType<typeof createApp>;
    const opened: string[] = [];

    beforeAll(async () => {
      await refreshLeg(testDb, "a", tee);
      await refreshLeg(testDb, "b", tee);
      tlog = await startLocalLog(testDbUrl);
      await testDb
        .insert(operators)
        .values({
          agentId: AGENT_ID,
          chainId: 421614,
          agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
          name: "Demo operator",
          cnfJwk: testAgent.jwk,
          clientId: AGENT_CLIENT,
        })
        .onConflictDoNothing();
      const kms = new KMSClient({
        region: process.env.AWS_REGION ?? "us-west-2",
        credentials: {
          accessKeyId: process.env.RELAYER_AWS_ACCESS_KEY_ID as string,
          secretAccessKey: process.env.RELAYER_AWS_SECRET_ACCESS_KEY as string,
        },
      });
      relayer = createRelayer({
        db: testDb,
        log,
        chains: {
          421614: {
            rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC_URL as string,
            fallbackRpcUrls: [ARBITRUM_SEPOLIA_PUBLIC_RPC],
            account: await kmsAccount({
              keyId: process.env.RELAYER_KMS_KEY_SANDBOX as string,
              client: kms,
            }),
          },
        },
      });
      const ops = operatorSigners(AGENT_ID, process.env.KEELSON_OPERATOR_KEY as Hex);
      deps = {
        db: testDb,
        kv: testKv,
        log,
        tlog: { url: tlog.url, token: tlog.token, vkeys: tlog.vkeys },
        relayer,
        operators: ops,
        chain: { client },
        paypal,
      };
      app = createApp({
        db: testDb,
        kv: testKv,
        log,
        appOrigin: "https://app.keelson.finance",
        authenticate: headerPrincipal,
        tee,
        tlog: { url: tlog.url, token: tlog.token, vkeys: tlog.vkeys },
        relayer,
        operators: ops,
        chains: { 421614: { client, logs: client } },
        paypal,
        requestTimeoutMs: 60_000,
      });
      uncaptured = createApp({
        db: testDb,
        kv: testKv,
        log,
        appOrigin: "https://app.keelson.finance",
        authenticate: headerPrincipal,
        tee,
        tlog: { url: tlog.url, token: tlog.token, vkeys: tlog.vkeys },
        relayer,
        operators: ops,
        chains: { 421614: { client, logs: client } },
        requestTimeoutMs: 60_000,
      });
    }, 300_000);

    afterAll(async () => {
      const h = holdHarness(app, paypal);
      for (const id of opened) await h.release(id);
      await tlog?.stop();
      await evidence.close();
    });

    /** A new user's mandate of `maxMinor`, for the demo operator, held and authorized on PayPal. */
    async function activeMandate(maxMinor: number) {
      const h = holdHarness(app, paypal);
      const s = await h.signed(
        (m) => {
          m.payment.constraints = m.payment.constraints.map((c) =>
            c.type === "payment.budget" || c.type === "payment.amount_range"
              ? { ...c, max: maxMinor }
              : c,
          );
        },
        { agentId: AGENT_ID },
      );
      const held = await h.activate(s.sub, s.mid);
      opened.push(held.authorizationId);
      return { ...s, ...held };
    }

    type Mandate = Awaited<ReturnType<typeof activeMandate>>;

    async function countersign(m: Mandate, minor: number, requestId = ulid()) {
      const cart = cartOf(minor);
      const body = {
        authorizationId: m.authorizationId,
        closedMandate: await closeMandate(
          m.openMandate,
          { requestId, cartHash: `sha256:${bytesToHex(cartHash(cart.cart)).slice(2)}` },
          m.agentKey,
        ),
        cart: cart.cart,
        unit: cart.unit,
        evidenceRoot: await evidence.upload(app, m.mid, cart.cart, asAgent),
        ...(await repeating(testDb, m.mid, cart.cart, requestId)),
      };
      const via = failNext.left-- > 0 ? uncaptured : app;
      const post = () =>
        via.request("/v1/countersign", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": ulid(), ...asAgent },
          body: JSON.stringify(body),
        });
      const started = performance.now();
      const res = await post();
      const out = (await res.json()) as Record<string, unknown> & {
        purchaseId: string;
        state: string;
        decision: string;
      };
      return { res, out, ms: performance.now() - started, requestId, post };
    }

    /** The purchase's state once its inline drive, which may outlive a `202`, has finished. */
    async function settled(id: string): Promise<string> {
      for (;;) {
        const p = await purchase(id);
        if (p && !["COUNTERSIGNED", "LOGGED", "COVERED"].includes(p.state)) return p.state;
        if (p?.state === "COVERED" && p.leaseUntil === null) return p.state;
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    const purchase = async (id: string) =>
      (await testDb.select().from(purchases).where(eq(purchases.id, id)))[0];

    /** The captures on the order whose invoice id is this purchase's. */
    async function capturesOf(orderId: string, purchaseId: string) {
      const order = await call(paypal.paypal.orders.getOrder({ id: orderId }));
      return (order.purchaseUnits ?? []).flatMap((u) =>
        (u.payments?.captures ?? []).filter((c) => c.invoiceId?.startsWith(`KS1-${purchaseId}-`)),
      );
    }

    let a: Mandate;
    let first: string;

    test("an ALLOW is logged, covered and captured before the countersign answers", async () => {
      a = await activeMandate(1_000);
      const { res, out, ms, post } = await countersign(a, 100);
      expect([200, 202], JSON.stringify(out).slice(0, 400)).toContain(res.status);
      console.info(`checkout ${ms.toFixed(0)} ms, ${res.status} ${out.state}`);
      first = out.purchaseId;
      expect(await settled(first)).toBe("CAPTURED");
      const p = await purchase(first);
      expect(p?.logIndex).not.toBeNull();
      expect(p?.coverageTxHash).not.toBeNull();
      expect(p?.paypalCaptureId).not.toBeNull();
      expect(ids.parseInvoiceId(p?.invoiceId as string)).toMatchObject({ id: first, seq: 1 });
      expect((await row(a.mid))?.remainingMinor).toBe(900n);

      const captures = await capturesOf(a.orderId, first);
      expect(captures.map((c) => c.amount?.value)).toEqual(["1.00"]);
      const cov = await client.readContract({
        address: VAULT,
        abi: keelsonBondVaultAbi,
        functionName: "coverages",
        args: [ulidToBytes32(first) as Hex],
      });
      expect(cov.status).toBe(1);
      expect(cov.amount).toBe(1_000_000n);

      const types = (
        await testDb
          .select({ payload: events.payload })
          .from(events)
          .where(
            eq(
              events.channel,
              principalChannel({ kind: "user", subject: a.sub }, `purchase:${first}`),
            ),
          )
          .orderBy(events.id)
      ).map((e) => (e.payload as { type: string }).type);
      expect(types).toEqual([
        "purchase.countersigned",
        "purchase.logged",
        "purchase.covered",
        "purchase.captured",
      ]);

      const view = await app.request(`/v1/purchases/${first}`, { headers: asAgent });
      expect(view.status).toBe(200);
      expect(await view.json()).toMatchObject({ id: first, state: "CAPTURED" });

      // The same request again never captures twice.
      const again = await post();
      expect(again.status).toBe(409);
      expect(await capturesOf(a.orderId, first)).toHaveLength(1);
    });

    let covered: string;

    test("a purchase its process could not capture stays COVERED, and two drivers capture it once", async () => {
      failNext.left = 1;
      const { res, out } = await countersign(a, 200);
      expect(res.status, JSON.stringify(out).slice(0, 400)).toBe(202);
      expect(res.headers.get("location")).toBe(`/v1/purchases/${out.purchaseId}`);
      covered = out.purchaseId;
      expect((await purchase(covered))?.state).toBe("COVERED");

      const [x, y] = await Promise.all([captureStep(deps, covered), captureStep(deps, covered)]);
      expect(x.kind).toBe("done");
      expect(y.kind).toBe("done");
      expect(x).toEqual(y);
      expect(await capturesOf(a.orderId, covered)).toHaveLength(1);
      expect((await row(a.mid))?.remainingMinor).toBe(700n);
    });

    test("a capture PayPal made but the database never recorded is adopted, not sent again", async () => {
      failNext.left = 1;
      const { out } = await countersign(a, 100);
      const id = out.purchaseId;
      expect((await purchase(id))?.state).toBe("COVERED");
      // The crashed driver took the invoice id and sent the capture: same request id, invoice, amount.
      await invoiceFor({ db: testDb, paypal }, id);
      const p = await purchase(id);
      const sent = await call(
        paypal.paypal.payments.captureAuthorizedPayment({
          authorizationId: a.authorizationId,
          paypalRequestId: ids.requestIdFromDigest(p?.countersignDigest as Buffer),
          body: {
            amount: { currencyCode: "USD", value: "1.00" },
            invoiceId: p?.invoiceId as string,
            finalCapture: false,
          },
        }),
      );
      const started = performance.now();
      const found = await findCapture(paypal, a.orderId, p?.invoiceId as string);
      console.info(`findCapture ${(performance.now() - started).toFixed(0)} ms`);
      expect(found?.id).toBe(sent.id);

      expect((await reconcileCapture(deps, sent.id as string)).effect).toBe("applied");
      expect((await reconcileCapture(deps, sent.id as string)).effect).toBe("unchanged");
      expect((await drivePurchase(deps, id)).state).toBe("CAPTURED");
      expect(await capturesOf(a.orderId, id)).toHaveLength(1);
      expect((await row(a.mid))?.remainingMinor).toBe(600n);
    });

    test("a capture after the window is refused and nothing is captured", async () => {
      failNext.left = 1;
      const { out } = await countersign(a, 100);
      const id = out.purchaseId;
      const cs = (await purchase(id))?.countersign as { issuedAt: string };
      const late = await captureStep(deps, id, () => (Number(cs.issuedAt) + 601) * 1000);
      expect(late).toEqual({ kind: "final", reason: "capture:window-closed" });
      expect(await capturesOf(a.orderId, id)).toHaveLength(0);
      expect((await row(a.mid))?.remainingMinor).toBe(600n);
    });

    test("a DENY is logged and never covered or captured", async () => {
      const { res, out } = await countersign(a, 2_000);
      expect(res.status, JSON.stringify(out).slice(0, 400)).toBe(200);
      expect(out.decision).toBe("deny");
      expect(out.state).toBe("DENIED");
      const p = await purchase(out.purchaseId);
      expect(p?.logIndex).not.toBeNull();
      expect(p?.coverageTxId).toBeNull();
      expect(await capturesOf(a.orderId, out.purchaseId)).toHaveLength(0);
    });

    test("the log being down leaves the purchase to the next drive", async () => {
      const down = { ...deps, tlog: { url: "http://127.0.0.1:9", token: "x".repeat(32) } };
      const out = await logStep(down, first);
      expect(out.kind).toBe("retry");
    });

    test("the capture that spends the last of the budget closes the hold", async () => {
      const b = await activeMandate(100);
      const { out } = await countersign(b, 100);
      expect(await settled(out.purchaseId)).toBe("CAPTURED");
      const m = await row(b.mid);
      expect(m?.remainingMinor).toBe(0n);
      expect(m?.state).toBe("EXHAUSTED");
      const auth = await call(
        paypal.paypal.payments.getAuthorizedPayment({ authorizationId: b.authorizationId }),
      );
      expect(auth.status).toBe("CAPTURED");
    });

    test("a hold voided before the capture fails the purchase with nothing captured", async () => {
      failNext.left = 1;
      const { out } = await countersign(a, 100);
      const id = out.purchaseId;
      expect((await purchase(id))?.state).toBe("COVERED");
      await holdHarness(app, paypal).release(a.authorizationId);
      const view = await drivePurchase(deps, id);
      expect(view.state).toBe("FAILED");
      expect(view.failure?.step).toBe("capture");
      expect(await capturesOf(a.orderId, id)).toHaveLength(0);
    });

    test("a mandate that is not ACTIVE countersigns nothing", async () => {
      const h = holdHarness(app, paypal);
      const s = await h.signed(undefined, { agentId: AGENT_ID });
      const m = await testDb.select().from(mandates).where(eq(mandates.id, s.mid));
      expect(m[0]?.state).toBe("SIGNED");
      const { res, out } = await countersign(
        { ...s, orderId: "", authorizationId: process.env.PAYPAL_AUTHORIZATION_CREATED as string },
        100,
      );
      expect(res.status).toBe(409);
      expect((out as { type?: string }).type).toMatch(/mandate-not-active$/);
    });
  },
);
