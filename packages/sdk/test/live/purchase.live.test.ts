import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  Keelson,
  login,
  type Mandate,
  MandateRequestClosedError,
  quote,
  storedLogin,
} from "../../src/index.ts";
import { buys, hasBuyer, judge, type User } from "./user.ts";

const live = process.env.KEELSON_LIVE === "1";
// Keelson's hosted operator backs at most $100 per user for an app it does not know.
const SHOE = "https://store.keelson.finance/products/pace-lite";
const REASON =
  "I am the SDK's live test. I buy one pair of Pace Lite running shoes, size 10, at RunFast on the PayPal sandbox, and nothing else.";

describe.skipIf(!live)(
  "buying through the SDK (live, PayPal sandbox)",
  { timeout: 300_000 },
  () => {
    let user: User;
    let keelson: Keelson;
    beforeAll(async () => {
      user = await judge();
      const path = join(await mkdtemp(join(tmpdir(), "keelson-purchase-")), "credentials.json");
      await login({ path, open: (url) => user.approveLogin(url), log: () => {} });
      keelson = new Keelson({ auth: storedLogin({ path }) });
    }, 180_000);
    afterAll(() => user?.close());

    const ask = (total = "$5") =>
      keelson.mandates.request({
        name: "SDK live test",
        reason: REASON,
        perPurchase: total,
        total,
        until: "1h",
      });

    test("the sandbox store prices the cart itself", async () => {
      const { cart, total, sources } = await quote([{ productUrl: SHOE, size: "10", qty: 1 }]);
      expect(cart.merchant).toBe("mrc_runfast");
      expect(cart.lines[0]).toMatchObject({ qty: 1, unit_minor: 9_900, size: "10" });
      expect(total).toMatchObject({ currency: "USD", minor: 9_900 });
      expect(sources.product).toMatchObject({ handle: "pace-lite" });
      await expect(
        quote([{ productUrl: "https://example.com/p", size: "10", qty: 1 }]),
      ).rejects.toThrow(/not on the store/);
    });

    test("a mandate request opens on Keelson's page, and the user's passkey approves it", async () => {
      const req = await ask();
      expect(req.approvalUrl).toMatch(/^https:\/\/app\.keelson\.finance\/connect\/?\?c=/);
      expect(req.matchNumber).toBeNull();
      expect((await keelson.requests.retrieve(req.id)).state).toBe("PENDING");
      await user.approveRequest(req.approvalUrl);
      const state = await keelson.requests.retrieve(req.id);
      expect(state.state).toBe("APPROVED");
      expect(state.mandateId).toMatch(/^[0-9A-Z]{26}$/);
      expect(state.operatorAgentId).toMatch(/^\d+$/);
      await user.revokeMandate(state.mandateId as string);
    });

    test("a declined request raises MandateRequestClosedError", async () => {
      const req = await ask();
      await user.denyRequest(req.approvalUrl);
      const err = await keelson.mandates.waitForApproval(req.id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MandateRequestClosedError);
      expect((err as MandateRequestClosedError).state).toBe("DENIED");
    });

    describe.skipIf(!hasBuyer || !buys("purchase-ts"))("held on PayPal", () => {
      let mandate: Mandate;
      let purchaseId: string;

      test("buys a sandbox pair and gets its Alibi", async () => {
        // What one user may spend through an app Keelson does not know is capped: this suite buys
        // as a user of its own.
        const buyer = await judge({ cache: "purchase" });
        const path = join(await mkdtemp(join(tmpdir(), "keelson-buyer-")), "credentials.json");
        await login({ path, open: (url) => buyer.approveLogin(url), log: () => {} });
        keelson = new Keelson({ auth: storedLogin({ path }) });
        const req = await ask("$100");
        await buyer.approveRequest(req.approvalUrl, { hold: true });
        await buyer.close();
        mandate = await keelson.mandates.waitForApproval(req.id, { timeoutMs: 120_000 });
        expect(mandate.authorizationId).toBeTruthy();
        const { cart, sources } = await quote([{ productUrl: SHOE, size: "10", qty: 1 }]);
        expect((await keelson.mandates.check(mandate.id, cart)).canAttempt).toBe(true);
        const { evidenceRoot } = await keelson.evidence.seal({
          mandateId: mandate.id,
          sources: { ...sources, observation: "Pace Lite, size 10, $99.00 at RunFast." },
        });
        const signed = await keelson.purchases.countersign({ mandate, evidenceRoot, cart });
        expect(signed.decision).toBe("allow");
        purchaseId = signed.purchaseId;
        const purchase = await keelson.purchases.waitFor(purchaseId);
        expect(purchase.state, JSON.stringify(purchase.failure)).toBe("CAPTURED");
        expect(purchase.capture?.id).toBeTruthy();
        expect((await keelson.alibis.retrieve(purchaseId)).byteLength).toBeGreaterThan(1000);
      });

      test("the same cart again is the same purchase, never a second one", async () => {
        const { cart, sources } = await quote([{ productUrl: SHOE, size: "10", qty: 1 }]);
        const { evidenceRoot } = await keelson.evidence.seal({
          mandateId: mandate.id,
          sources: { ...sources, observation: "Pace Lite, size 10, $99.00 at RunFast." },
        });
        const again = await keelson.purchases.countersign({ mandate, evidenceRoot, cart });
        expect(again.existing).toBe(true);
        expect(again.purchaseId).toBe(purchaseId);
      });
    });
  },
);
