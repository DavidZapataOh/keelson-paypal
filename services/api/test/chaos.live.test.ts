import { and, eq, mandates, paypalEvents } from "@keelson/db";
import { createPublicClient, type PublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { arbitrumSepoliaTransport } from "../src/chain/rpc.ts";
import { call } from "../src/paypal.ts";
import { capturesOf, checkBudget, checkInvariants } from "./invariants.ts";
import { type Hold, onRender, renderHarness, UNREACHABLE } from "./render-live.ts";

// Failures injected into one API instance while the deployed service runs beside it on the same
// database, as a second instance would: whatever this instance leaves mid-way, the service resumes.
describe.skipIf(!onRender)(
  "the money path under injected failures (live)",
  { timeout: 600_000 },
  () => {
    let h: Awaited<ReturnType<typeof renderHarness>>;
    let chain: PublicClient;
    let hold: Hold;
    const invariants = (id: string) => checkInvariants({ db: h.db, paypal: h.paypal, chain }, id);
    const remaining = async () =>
      (await h.db.select().from(mandates).where(eq(mandates.id, hold.mid)))[0]?.remainingMinor ??
      0n;

    beforeAll(async () => {
      h = await renderHarness();
      chain = createPublicClient({
        chain: arbitrumSepolia,
        transport: arbitrumSepoliaTransport(process.env.ARBITRUM_SEPOLIA_RPC_URL),
      }) as PublicClient;
      hold = await h.openHold(1_000);
    }, 300_000);

    afterAll(async () => {
      await h?.close();
    });

    test("leg B unreachable: leg A alone countersigns and the purchase is captured", async () => {
      const r = await h.countersign(hold, 100, await h.appWith({ teeB: UNREACHABLE }));
      expect(r.status, JSON.stringify(r.out).slice(0, 300)).toBeLessThan(300);
      expect(await h.settled(r.requestId)).toBe("CAPTURED");
      expect((await h.purchase(r.requestId))?.countersignMode).toBe("degraded");
      await invariants(r.requestId);
    });

    test("leg A unreachable: nothing is signed, logged, locked or captured", async () => {
      const r = await h.countersign(hold, 100, await h.appWith({ teeA: UNREACHABLE }));
      expect(r.status).toBe(503);
      const p = await h.purchase(r.requestId);
      expect(p?.state).toBe("FAILED");
      expect(p?.countersign).toBeNull();
      expect(p?.logIndex).toBeNull();
      expect(p?.coverageTxId).toBeNull();
      await invariants(r.requestId);
    });

    test.each([
      ["the log's private listener", { logUrl: UNREACHABLE }],
      ["the RPC", { rpcUrl: UNREACHABLE }],
    ])("%s unreachable: the purchase waits, then the service captures it once", async (_, over) => {
      const r = await h.countersign(hold, 100, await h.appWith(over));
      expect(r.status, JSON.stringify(r.out).slice(0, 300)).toBeLessThan(300);
      const left = await h.purchase(r.requestId);
      expect(["COUNTERSIGNED", "LOGGED", "COVERED"]).toContain(left?.state);
      expect(await h.settled(r.requestId)).toBe("CAPTURED");
      await invariants(r.requestId);
    });

    test("one cart sent twice at once, under one key and under two, is one purchase", async () => {
      const { requestId, body } = await h.cartBody(hold, 100);
      const [a, b, c] = await Promise.all([
        h.send(h.app, body, `same-${requestId}`),
        h.send(h.app, body, `same-${requestId}`),
        h.send(h.app, body),
      ]);
      const ok = [a, b, c].filter((x) => x.status < 300);
      expect(ok.length).toBeGreaterThanOrEqual(1);
      for (const x of [a, b, c]) expect([200, 202, 409]).toContain(x.status);
      for (const x of ok) expect(x.out.purchaseId).toBe(requestId);
      expect(await h.settled(requestId)).toBe("CAPTURED");
      expect(await capturesOf(h.paypal, hold.orderId, requestId)).toHaveLength(1);
      await invariants(requestId);
    });

    test("a cart above the remaining budget is denied and logged, never locked or captured", async () => {
      const r = await h.countersign(hold, Number(await remaining()) + 100);
      expect(r.out.decision).toBe("deny");
      expect(await h.settled(r.requestId)).toBe("DENIED");
      expect((await h.purchase(r.requestId))?.coverageTxId).toBeNull();
      await invariants(r.requestId);
    });

    test("the purchase that spends the rest ends the mandate, and the next is refused", async () => {
      // A hold of its own: a purchase that failed after its countersign keeps leg A's
      // reservation for the countersign's lifetime, so the shared hold has less left than its
      // budget says.
      const own = await h.openHold(200);
      const first = await h.countersign(own, 100);
      expect(await h.settled(first.requestId)).toBe("CAPTURED");
      // Evidence is only accepted for a usable mandate: the refused cart's is uploaded first.
      const refused = await h.cartBody(own, 100);
      const r = await h.countersign(own, 100);
      expect(await h.settled(r.requestId)).toBe("CAPTURED");
      await invariants(r.requestId);
      const [m] = await h.db.select().from(mandates).where(eq(mandates.id, own.mid));
      expect(m?.state).toBe("EXHAUSTED");
      const next = await h.send(h.app, refused.body);
      expect(next.status).toBe(409);
      expect(next.out.type).toContain("mandate-not-active");
      await checkBudget({ db: h.db, paypal: h.paypal }, own.mid);
    });
    test("a hold voided outside Keelson ends its mandate, and the next countersign is refused", async () => {
      const own = await h.openHold(200);
      // Evidence is only accepted for a usable mandate: the refused cart's is uploaded first.
      const refused = await h.cartBody(own, 100);
      await call(
        h.paypal.paypal.payments.voidPayment({
          authorizationId: own.authorizationId,
          paypalRequestId: `external-void-${own.authorizationId}`,
        }),
      );
      let state: string | undefined;
      for (let i = 0; i < 90 && state !== "EXPIRED"; i++) {
        await new Promise((r) => setTimeout(r, 2_000));
        state = (await h.db.select().from(mandates).where(eq(mandates.id, own.mid)))[0]?.state;
      }
      expect(state, "mandate after PAYMENT.AUTHORIZATION.VOIDED").toBe("EXPIRED");
      const [event] = await h.db
        .select()
        .from(paypalEvents)
        .where(
          and(
            eq(paypalEvents.eventType, "PAYMENT.AUTHORIZATION.VOIDED"),
            eq(paypalEvents.resourceId, own.authorizationId),
          ),
        );
      expect(event?.mandateId).toBe(own.mid);
      const next = await h.send(h.app, refused.body);
      expect(next.status).toBe(409);
      expect(next.out.type).toContain("mandate-not-active");
    });
  },
);
