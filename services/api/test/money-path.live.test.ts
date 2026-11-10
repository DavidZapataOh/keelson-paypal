import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAlibi, verifyUrl } from "@keelson/alibi";
import { extractAlibi } from "@keelson/alibi/extract";
import { alibis, and, eq, mandates, paypalEvents } from "@keelson/db";
import { LOG_ORIGINS } from "@keelson/log";
import { ids } from "@keelson/paypal";
import { chromium, type Page } from "playwright";
import { createPublicClient, type PublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { arbitrumSepoliaTransport } from "../src/chain/rpc.ts";
import { call } from "../src/paypal.ts";
import { capturesOf, checkBudget, checkInvariants } from "./invariants.ts";
import { type Hold, onRender, renderHarness, UNREACHABLE } from "./render-live.ts";
import { asUser } from "./tee-live.ts";

const PUBLIC_API = "https://api.keelson.finance";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Each step's wall time and the ids it produced, printed as one JSON line at the end. */
const record: Record<string, unknown> = {};

// One sandbox mandate walked from its passkey signature to Alibis verified in the browser: two
// purchases captured on one hold (2-of-2 and degraded), a denied one, the void of the remainder,
// the anchor, the PDF and the verifier.
describe.skipIf(!onRender)("the money path, end to end (live)", { timeout: 900_000 }, () => {
  let h: Awaited<ReturnType<typeof renderHarness>>;
  let chain: PublicClient;
  let hold: Hold;
  const bought: { id: string; mode: string }[] = [];

  /** Resolves once PayPal's event about `resourceId` was stored from a webhook and applied. */
  async function applied(eventType: string, resourceId: string) {
    for (let i = 0; i < 90; i++) {
      const [e] = await h.db
        .select()
        .from(paypalEvents)
        .where(and(eq(paypalEvents.eventType, eventType), eq(paypalEvents.resourceId, resourceId)));
      if (e && e.status !== "received" && e.status !== "inflight") return e;
      await sleep(2_000);
    }
    return undefined;
  }

  const timed = async <T>(step: string, f: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    const out = await f();
    record[`${step}Ms`] = Math.round(performance.now() - started);
    return out;
  };

  beforeAll(async () => {
    h = await renderHarness();
    chain = createPublicClient({
      chain: arbitrumSepolia,
      transport: arbitrumSepoliaTransport(process.env.ARBITRUM_SEPOLIA_RPC_URL),
    }) as PublicClient;
  }, 120_000);

  afterAll(async () => {
    console.log(`WALK ${JSON.stringify(record)}`);
    await h?.close();
  });

  test("1–2. a signed mandate is held on PayPal and becomes ACTIVE", async () => {
    hold = await timed("hold", () => h.openHold(300));
    const [m] = await h.db.select().from(mandates).where(eq(mandates.id, hold.mid));
    expect(m?.state).toBe("ACTIVE");
    const order = await call(h.paypal.paypal.orders.getOrder({ id: hold.orderId }));
    const custom = ids.parseCustomId(order.purchaseUnits?.[0]?.customId ?? "");
    expect(custom).toMatchObject({ env: "s", id: hold.mid });
    Object.assign(record, {
      mandate: hold.mid,
      order: hold.orderId,
      authorization: hold.authorizationId,
    });
  });

  test("3. a 2-of-2 purchase is logged, covered and partially captured", async () => {
    const r = await timed("purchase1", async () => {
      const r = await h.countersign(hold, 100);
      await h.settled(r.requestId);
      return r;
    });
    const p = await h.purchase(r.requestId);
    expect(p?.state, p?.failureReason ?? "").toBe("CAPTURED");
    expect(p?.countersignMode).toBe("2of2");
    expect(ids.parseInvoiceId(p?.invoiceId as string)).toMatchObject({ id: r.requestId });
    await checkInvariants({ db: h.db, paypal: h.paypal, chain }, r.requestId);
    const event = await applied("PAYMENT.CAPTURE.COMPLETED", p?.paypalCaptureId as string);
    expect(event?.status, "webhook of the capture").toBeDefined();
    bought.push({ id: r.requestId, mode: "2of2" });
    Object.assign(record, {
      purchase1: r.requestId,
      logIndex1: p?.logIndex?.toString(),
      coverageTx1: p?.coverageTxHash ? `0x${Buffer.from(p.coverageTxHash).toString("hex")}` : null,
      capture1: p?.paypalCaptureId,
      captureWebhook1: event?.status,
    });
  });

  test("4. with leg B unreachable the next purchase is degraded and captured", async () => {
    const r = await h.countersign(hold, 100, await h.appWith({ teeB: UNREACHABLE }));
    expect(await h.settled(r.requestId)).toBe("CAPTURED");
    const p = await h.purchase(r.requestId);
    expect(p?.countersignMode).toBe("degraded");
    await checkInvariants({ db: h.db, paypal: h.paypal, chain }, r.requestId);
    bought.push({ id: r.requestId, mode: "degraded" });
    Object.assign(record, { purchase2: r.requestId, capture2: p?.paypalCaptureId });
  });

  test("5. a purchase above the remaining budget is denied and logged", async () => {
    const r = await h.countersign(hold, 200);
    expect(await h.settled(r.requestId)).toBe("DENIED");
    await checkInvariants({ db: h.db, paypal: h.paypal, chain }, r.requestId);
    expect(await capturesOf(h.paypal, hold.orderId)).toHaveLength(2);
    record.purchase3 = r.requestId;
  });

  test("6. revoking voids the remainder of the hold", async () => {
    const revoked = await timed("revoke", () =>
      h.post(`/v1/mandates/${hold.mid}/revoke`, asUser(hold.sub)),
    );
    expect(revoked.status, JSON.stringify(revoked.out)).toBeLessThan(300);
    const [m] = await h.db.select().from(mandates).where(eq(mandates.id, hold.mid));
    expect(m?.state).toBe("REVOKED");
    const auth = await call(
      h.paypal.paypal.payments.getAuthorizedPayment({ authorizationId: hold.authorizationId }),
    );
    expect(auth.status).toBe("VOIDED");
    const event = await applied("PAYMENT.AUTHORIZATION.VOIDED", hold.authorizationId);
    record.voidWebhook = event?.status;
    await checkBudget({ db: h.db, paypal: h.paypal }, hold.mid);
  });

  test("7. anchoring now re-issues both Alibis with their anchor", async () => {
    const path = (LOG_ORIGINS[421614] as string).replace(/^[^/]+\//, "");
    const res = await fetch(`${h.tlog.url.replace(/\/$/, "")}/${path}/anchor`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.tlog.token}` },
    });
    expect(res.status).toBe(200);
    const anchored = (await res.json()) as { size: number; tx: string };
    Object.assign(record, { anchoredSize: anchored.size, anchorTx: anchored.tx });
    const started = performance.now();
    for (const b of bought) {
      for (let i = 0; ; i++) {
        const [a] = await h.db.select().from(alibis).where(eq(alibis.purchaseId, b.id));
        if (a?.anchor) break;
        expect(i, `alibi ${b.id} re-issued with its anchor`).toBeLessThan(150);
        await sleep(2_000);
      }
    }
    record.reissueMs = Math.round(performance.now() - started);
  });

  test("8. the PDF carries the served bundle and the receipt is public", async () => {
    for (const b of bought) {
      const served = new Uint8Array(
        await (
          await h.app.request(`/v1/alibis/${b.id}`, { headers: asUser(hold.sub) })
        ).arrayBuffer(),
      );
      const pdfRes = await h.app.request(`/v1/alibis/${b.id}.pdf`, { headers: asUser(hold.sub) });
      expect(pdfRes.status).toBe(200);
      const pdf = new Uint8Array(await pdfRes.arrayBuffer());
      expect(pdf.length).toBeLessThanOrEqual(512 * 1024);
      expect(Buffer.from(await extractAlibi(pdf)).equals(Buffer.from(served))).toBe(true);
      const receipt = await fetch(`${PUBLIC_API}/v1/alibis/${b.id}/receipt`);
      expect(receipt.status).toBe(200);
      record[`pdfBytes_${b.mode}`] = pdf.length;
      record[`bundleBytes_${b.mode}`] = served.length;
    }
  });

  test("9. verify.keelson.finance verifies both, and an edit fails", async () => {
    const browser = await chromium.launch();
    const verdict = async (page: Page) => {
      const el = page.locator("[data-verdict]:not([data-verdict=running])");
      await el.waitFor({ timeout: 60_000 });
      return el.getAttribute("data-verdict");
    };
    try {
      for (const b of bought) {
        const served = new Uint8Array(
          await (
            await h.app.request(`/v1/alibis/${b.id}`, { headers: asUser(hold.sub) })
          ).arrayBuffer(),
        );
        const bundle = decodeAlibi(served);
        if (!("tee" in bundle)) throw new Error("not a full bundle");
        const page = await browser.newPage();
        const started = performance.now();
        await page.goto(verifyUrl(bundle));
        record[`qrVerdict_${b.mode}`] = await verdict(page);
        record[`qrMs_${b.mode}`] = Math.round(performance.now() - started);
        const pdf = new Uint8Array(
          await (
            await h.app.request(`/v1/alibis/${b.id}.pdf`, { headers: asUser(hold.sub) })
          ).arrayBuffer(),
        );
        const file = join(tmpdir(), `${b.id}.pdf`);
        writeFileSync(file, pdf);
        await page.setInputFiles("[data-testid=file]", file);
        const full = await verdict(page);
        record[`pdfVerdict_${b.mode}`] = full;
        expect(full).toBe("verified");
        if (b.mode === "degraded")
          await page.getByText("Degraded", { exact: false }).first().waitFor();
        if (b.mode === "2of2") {
          await page.locator("summary", { hasText: "leaf" }).first().click();
          const input = page.locator('[data-pointer="/leaf/cart_hash"]');
          const value = await input.inputValue();
          await input.fill(`${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`);
          await input.press("Enter");
          await page.locator("[data-verdict=failed]").waitFor();
          record.editVerdict = "failed";
        }
        await page.close();
      }
    } finally {
      await browser.close();
    }
  });
});
