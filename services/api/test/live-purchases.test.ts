// Loads reflect-metadata before @keelson/alibi/verify pulls in @keelson/attest (see tee/attest.ts).
import "../src/tee/attest.ts";
import { randomBytes } from "node:crypto";
import { decodeAlibi, leafHashOf } from "@keelson/alibi";
import { extractAlibi } from "@keelson/alibi/extract";
import { verifyAlibi } from "@keelson/alibi/verify";
import {
  type Conversion,
  captureCeiling,
  DEFAULT_MAX_SPREAD_BPS,
  type FxReference,
} from "@keelson/core";
import {
  alibis,
  eq,
  evidenceBundles,
  evidenceItems,
  mandates,
  purchases,
  sql,
  user,
} from "@keelson/db";
import { buildSdPayload, parseMandate } from "@keelson/mandate";
import { pino } from "pino";
import { ulid } from "ulid";
import { beforeAll, describe, expect, test } from "vitest";
import { fixtures } from "../../../packages/alibi/test/fixtures.ts";
import demo from "../../../packages/mandate/test/fixtures/demo-mandate.json" with { type: "json" };
import { loadAlibi } from "../src/alibi/issue.ts";
import { createApp } from "../src/app.ts";
import { commitmentBytes } from "../src/fx.ts";
import { drivePurchase, resumePurchases } from "../src/pipeline/drive.ts";
import { channel3Mandate } from "./channel3.ts";
import { testDb, testKv } from "./setup.ts";
import { headerPrincipal } from "./tee-live.ts";

const app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  authenticate: headerPrincipal,
});
const agent = "observer-agent";
const asClient = (subject: string, scopes = ["countersign:write"]) => ({
  "x-test-principal": JSON.stringify({ kind: "client", subject, scopes }),
});
const STORE = "https://www.alfred.com";
const TX = "8MC585209K746392H";

const record = (id: string, transactionId: string, headers = asClient(agent)) =>
  app.request(`/v1/purchases/${id}/paypal-transaction`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ transactionId }),
  });

async function purchase(
  mandateId: string,
  state: "COUNTERSIGNED" | "LOGGED",
  liveStore: string | null,
  id = ulid(),
) {
  await testDb.insert(purchases).values({
    id,
    mandateId,
    clientId: agent,
    state,
    liveStore,
    merchantId: "mrc_alfred",
    currency: "USD",
    amountMinor: 295n,
    cartHash: randomBytes(32),
    countersign: { issuedAt: String(Math.floor(Date.now() / 1000)) },
    logIndex:
      state === "LOGGED" ? BigInt(Date.now()) * 1000n + BigInt(randomBytes(1)[0] ?? 0) : null,
    updatedAt: sql`now() - interval '1 minute'`,
  });
  return id;
}

describe("live purchases", () => {
  let mandateId: string;
  beforeAll(async () => {
    mandateId = await channel3Mandate();
  });

  test("a logged live purchase is neither covered nor captured, nor resumed", async () => {
    const live = await purchase(mandateId, "LOGGED", STORE);
    const view = await drivePurchase(
      { db: testDb, kv: testKv, log: pino({ level: "silent" }) },
      live,
    );
    expect(view.state).toBe("LOGGED");
    expect(view.live).toEqual({ store: STORE, transactionId: null });
    await resumePurchases({ db: testDb, kv: testKv, log: pino({ level: "silent" }) });
    const [p] = await testDb.select().from(purchases).where(eq(purchases.id, live));
    expect(p?.state).toBe("LOGGED");
    expect(p?.coverageTxId).toBeNull();
    expect(p?.failureReason).toBeNull();
  });

  test("the client that asked records the PayPal transaction id once", async () => {
    const id = await purchase(mandateId, "LOGGED", STORE);
    const res = await record(id, TX);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { live: unknown }).live).toEqual({
      store: STORE,
      transactionId: TX,
    });
    expect((await record(id, TX)).status).toBe(200);
    const other = await record(id, "1AB23456CD789012E");
    expect(other.status).toBe(409);
    expect(((await other.json()) as { type: string }).type).toMatch(/transaction-recorded$/);
    const second = await purchase(mandateId, "LOGGED", STORE);
    expect((await record(second, TX)).status).toBe(409);
  });

  test("only a logged live purchase of the caller takes a transaction id", async () => {
    const sandbox = await purchase(mandateId, "LOGGED", null);
    expect((await record(sandbox, "2AB23456CD789012E")).status).toBe(409);
    const pending = await purchase(mandateId, "COUNTERSIGNED", STORE);
    expect((await record(pending, "3AB23456CD789012E")).status).toBe(409);
    const live = await purchase(mandateId, "LOGGED", STORE);
    expect((await record(live, "4AB23456CD789012E", asClient("another"))).status).toBe(404);
    expect(
      (await record(live, "4AB23456CD789012E", asClient(agent, ["evidence:write"]))).status,
    ).toBe(403);
    expect((await record(live, "not a paypal id")).status).toBe(422);
  });

  test("PayPal's order and its conversion are recorded with the transaction, checked against the evidence", async () => {
    const reference: FxReference = {
      v: "keelson.fx_reference/1",
      provider: "ExchangeRate-API",
      source: "https://open.er-api.com/v6/latest/USD",
      base: "USD",
      as_of: "2026-11-11T00:02:32.000Z",
      fetched_at: "2026-11-11T12:00:00.000Z",
      rates: { COP: "3276.876985", EUR: "0.89871" },
    };
    const conversion: Conversion = {
      v: "keelson.conversion/1",
      merchant: { currency: "USD", value: "2.95" },
      buyer: { currency: "COP", value: "10231" },
      rate: "3468.14",
      reference: {
        rate: "3276.876985",
        provider: reference.provider,
        source: reference.source,
        as_of: reference.as_of,
      },
      spread_bps: 584,
      max_spread_bps: DEFAULT_MAX_SPREAD_BPS,
      locale: "es-CO",
    };
    // A mandate signed as the demo one, which allows paying MERCH7XK2Q9LD.
    const sd = await buildSdPayload(parseMandate(demo), () => randomBytes(16));
    await testDb
      .update(mandates)
      .set({ payloadSd: sd.payloadSd, disclosures: sd.disclosures })
      .where(eq(mandates.id, mandateId));
    const order = { intent: "AUTHORIZE", payee: "MERCH7XK2Q9LD" };
    const put = async (id: string, transactionId: string, body: Record<string, unknown>) =>
      app.request(`/v1/purchases/${id}/paypal-transaction`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...asClient(agent) },
        body: JSON.stringify({ transactionId, order, ...body }),
      });
    /** A logged live purchase whose evidence binds `reference`. */
    const live = async () => {
      const root = randomBytes(32);
      await testDb
        .insert(evidenceBundles)
        .values({ root, mandateId, manifest: {}, uploadedBy: agent });
      await testDb.insert(evidenceItems).values({
        root,
        index: 0,
        type: "api.fx_reference",
        mediaType: "application/json",
        contentHash: randomBytes(32),
        salt: randomBytes(32),
        bytes: Buffer.from(commitmentBytes(reference)),
      });
      const id = await purchase(mandateId, "LOGGED", STORE);
      await testDb.update(purchases).set({ evidenceRoot: root }).where(eq(purchases.id, id));
      return id;
    };
    for (const [n, wrong] of [
      { ...conversion, rate: "3500.00" },
      { ...conversion, merchant: { currency: "USD", value: "3.95" } },
      { ...conversion, reference: { ...conversion.reference, rate: "3100" } },
      { ...conversion, max_spread_bps: 500 },
      { ...conversion, spread_bps: 900, max_spread_bps: 1000 },
    ].entries()) {
      const res = await put(await live(), `6AB2345${n}CD789012E`, { conversion: wrong });
      expect(res.status, JSON.stringify(wrong)).toBe(422);
    }
    const unbound = await purchase(mandateId, "LOGGED", STORE);
    expect((await put(unbound, "7AB23456CD789012E", { conversion })).status).toBe(422);
    // Another payee: the transaction is recorded, the report is not.
    const elsewhere = await live();
    const res = await put(elsewhere, "9AB23456CD789012E", {
      conversion,
      order: { ...order, payee: "OTHERPAYEE01" },
    });
    expect(res.status).toBe(422);
    const [kept] = await testDb.select().from(purchases).where(eq(purchases.id, elsewhere));
    expect(kept).toMatchObject({
      paypalTransactionId: "9AB23456CD789012E",
      paypalPayeeId: null,
      conversion: null,
    });
    const id = await live();
    expect((await put(id, "8AB23456CD789012E", { conversion })).status).toBe(200);
    const [row] = await testDb.select().from(purchases).where(eq(purchases.id, id));
    expect(row).toMatchObject({
      paypalOrderIntent: "AUTHORIZE",
      paypalPayeeId: "MERCH7XK2Q9LD",
      conversion,
    });
  });

  test("a mandate that names no PayPal merchant, only a placeholder, allows recording none", async () => {
    const id = await channel3Mandate();
    const m = parseMandate(demo);
    m.payment.constraints = m.payment.constraints.map((c) =>
      c.type === "payment.allowed_payees"
        ? { ...c, allowed: [{ paypal_merchant_id: "unknown" }] }
        : c,
    );
    const sd = await buildSdPayload(m, () => randomBytes(16));
    await testDb
      .update(mandates)
      .set({ payloadSd: sd.payloadSd, disclosures: sd.disclosures })
      .where(eq(mandates.id, id));
    const live = await purchase(id, "LOGGED", STORE);
    const res = await app.request(`/v1/purchases/${live}/paypal-transaction`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...asClient(agent) },
      body: JSON.stringify({
        transactionId: "4AB23456CD789012E",
        order: { intent: "AUTHORIZE", payee: "DZ93UDZC2BKLE" },
      }),
    });
    expect(res.status).toBe(422);
    const [row] = await testDb.select().from(purchases).where(eq(purchases.id, live));
    expect(row).toMatchObject({ paypalTransactionId: "4AB23456CD789012E", paypalPayeeId: null });
  });
});

const f = fixtures[0];

describe.skipIf(!f)("live Alibis are public", () => {
  const b = f?.bundle as NonNullable<typeof f>["bundle"];
  let owner: string;
  beforeAll(async () => {
    const mandateId = await channel3Mandate();
    const [m] = await testDb.select().from(mandates).where(eq(mandates.id, mandateId));
    owner = m?.userId as string;
    const c = b.tee.countersign;
    await testDb.insert(purchases).values({
      id: b.alibi_id,
      mandateId,
      clientId: agent,
      state: "LOGGED",
      liveStore: STORE,
      paypalTransactionId: "5MC585209K746392H",
      merchantId: String(b.eval.context.merchant),
      currency: "USD",
      amountMinor: BigInt(c.amount),
      cartHash: Buffer.from(c.cartHash.slice(2), "hex"),
      logIndex: 7n,
    });
    const { timestamps: _t, anchor: _a, ...core } = b;
    await testDb.insert(alibis).values({
      purchaseId: b.alibi_id,
      leafHash: Buffer.from(leafHashOf(b)),
      bundle: {
        ...core,
        timestamps: [],
        paypal: { ...core.paypal, capture_id: undefined, invoice_id: undefined },
      },
    });
  });

  test("anyone reads a live Alibi, with the PayPal transaction id", async () => {
    const res = await app.request(`/v1/alibis/${b.alibi_id}`);
    expect(res.status).toBe(200);
    const bundle = decodeAlibi(new Uint8Array(await res.arrayBuffer()));
    expect(bundle.paypal?.transaction_id).toBe("5MC585209K746392H");
  });

  test("the Alibi carries the store's PayPal order and its capture ceiling, and the conversion", async () => {
    const conversion = {
      v: "keelson.conversion/1",
      merchant: { currency: "USD", value: "2.95" },
      buyer: { currency: "COP", value: "10231" },
      rate: "3468.14",
      reference: {
        rate: "3276.876985",
        provider: "ExchangeRate-API",
        source: "https://open.er-api.com/v6/latest/USD",
        as_of: "2026-11-11T00:02:32.000Z",
      },
      spread_bps: 584,
      max_spread_bps: 750,
      locale: "es-CO",
    };
    const set = (o: Partial<typeof purchases.$inferInsert>) =>
      testDb.update(purchases).set(o).where(eq(purchases.id, b.alibi_id));
    await set({ paypalOrderIntent: "AUTHORIZE", paypalPayeeId: "MERCH7XK2Q9LD", conversion });
    try {
      const alibi = await loadAlibi(testDb, b.alibi_id);
      const amount = Number(b.tee.countersign.amount);
      expect(alibi?.paypal?.store_order).toEqual({
        intent: "AUTHORIZE",
        payee_id: "MERCH7XK2Q9LD",
        capture_ceiling_minor: String(captureCeiling("USD", amount)),
      });
      expect(alibi?.conversion).toEqual(conversion);
      await set({ paypalOrderIntent: "SALE", conversion: null });
      expect((await loadAlibi(testDb, b.alibi_id))?.paypal?.store_order).toEqual({
        intent: "SALE",
        payee_id: "MERCH7XK2Q9LD",
      });
    } finally {
      await set({ paypalOrderIntent: null, paypalPayeeId: null, conversion: null });
    }
  });

  test("the public copy withholds the user's login id and risk data, and verifies", async () => {
    const names = (ds: string[]) =>
      ds.map((d) => JSON.parse(Buffer.from(d, "base64url").toString())[1]);
    expect(names(b.mandate.disclosures)).toContain("app_login_id");
    const res = await app.request(`/v1/alibis/${b.alibi_id}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const pub = decodeAlibi(bytes);
    for (const shown of [pub.mandate.disclosures, pub.mandate.sd_jwt.split("~").slice(3, -1)]) {
      expect(names(shown)).not.toContain("app_login_id");
      expect(names(shown)).not.toContain("risk_data");
    }
    const login = b.mandate.disclosures.find((d) => names([d])[0] === "app_login_id") as string;
    const email = JSON.parse(Buffer.from(login, "base64url").toString())[2] as string;
    expect(Buffer.from(bytes).toString()).not.toContain(email);
    const risk = b.mandate.disclosures.find((d) => names([d])[0] === "risk_data") as string;
    const { ip, device_fp } = JSON.parse(Buffer.from(risk, "base64url").toString())[2];
    for (const value of [ip, device_fp]) expect(Buffer.from(bytes).toString()).not.toContain(value);
    const pdf = await app.request(`/v1/alibis/${b.alibi_id}.pdf`);
    expect(pdf.status).toBe(200);
    const embedded = decodeAlibi(await extractAlibi(new Uint8Array(await pdf.arrayBuffer())));
    expect(names(embedded.mandate.disclosures)).not.toContain("app_login_id");
    expect(names(embedded.mandate.disclosures)).not.toContain("risk_data");
    const report = await verifyAlibi(pub);
    expect(report.checks.filter((c) => c.status === "fail")).toEqual([]);
  });

  test("the mandate's user still reads the whole Alibi", async () => {
    const res = await app.request(`/v1/alibis/${b.alibi_id}`, {
      headers: { "x-test-principal": JSON.stringify({ kind: "user", subject: owner }) },
    });
    expect(res.status).toBe(200);
    const full = decodeAlibi(new Uint8Array(await res.arrayBuffer()));
    expect(full.mandate.disclosures).toEqual(b.mandate.disclosures);
  });

  test("the live purchases list names the store, the amount and the transaction", async () => {
    const res = await app.request("/v1/live-purchases");
    expect(res.status).toBe(200);
    const { purchases: list } = (await res.json()) as {
      purchases: { id: string; store: string; transactionId: string; amount: unknown }[];
    };
    const row = list.find((p) => p.id === b.alibi_id);
    expect(row).toMatchObject({ store: STORE, transactionId: "5MC585209K746392H" });
    expect(row).toMatchObject({ decision: "allow", blocked: [] });
    // A live purchase without an Alibi is not listed.
    expect(list.filter((p) => p.id !== b.alibi_id && p.transactionId)).toEqual([]);
  });
});

const g = fixtures[1];

describe.skipIf(!g)("denied live carts", () => {
  const b = g?.bundle as NonNullable<typeof g>["bundle"];
  let demo: ReturnType<typeof createApp>;
  let mandateId: string;
  beforeAll(async () => {
    mandateId = await channel3Mandate();
    const [m] = await testDb.select().from(mandates).where(eq(mandates.id, mandateId));
    demo = createApp({
      db: testDb,
      kv: testKv,
      log: pino({ level: "silent" }),
      authenticate: headerPrincipal,
      demoAgentId: m?.operatorAgentId,
    });
  });
  const insert = async (
    liveStore: string | null,
    state: "DENIED" | "LOGGED",
    mandate = mandateId,
  ) => {
    const id = ulid();
    const c = b.tee.countersign;
    await testDb.insert(purchases).values({
      id,
      mandateId: mandate,
      clientId: agent,
      state,
      liveStore,
      merchantId: String(b.eval.context.merchant),
      currency: "USD",
      amountMinor: BigInt(c.amount),
      cartHash: Buffer.from(c.cartHash.slice(2), "hex"),
      evalTrace: {
        fields: [
          { id: "budget", pass: false },
          { id: "merchant", pass: true },
        ],
      },
      logIndex: BigInt(Date.now()) * 1000n + BigInt(randomBytes(1)[0] ?? 0),
    });
    const { timestamps: _t, anchor: _a, ...core } = b;
    await testDb.insert(alibis).values({
      purchaseId: id,
      leafHash: randomBytes(32),
      bundle: {
        ...core,
        alibi_id: id,
        timestamps: [],
        paypal: { ...core.paypal, capture_id: undefined, invoice_id: undefined },
      },
    });
    return id;
  };
  const listed = async () =>
    (
      (await (await demo.request("/v1/live-purchases")).json()) as {
        purchases: { id: string; decision: string; transactionId: unknown; blocked: string[] }[];
      }
    ).purchases;

  test("a live cart the demo operator ran and Keelson denied is public and listed with why", async () => {
    const id = await insert(STORE, "DENIED");
    expect((await demo.request(`/v1/alibis/${id}`)).status).toBe(200);
    expect((await listed()).find((p) => p.id === id)).toMatchObject({
      decision: "deny",
      transactionId: null,
      blocked: ["budget"],
    });
  });

  test("other denied carts, a real user's and unpaid live purchases stay private", async () => {
    const sandbox = await insert(null, "DENIED");
    const unpaid = await insert(STORE, "LOGGED");
    const another = await insert(STORE, "DENIED", await channel3Mandate());
    // A real user's mandate under the demo operator.
    const real = await channel3Mandate();
    const [demoMandate] = await testDb.select().from(mandates).where(eq(mandates.id, mandateId));
    const [realMandate] = await testDb
      .update(mandates)
      .set({ operatorAgentId: demoMandate?.operatorAgentId as bigint })
      .where(eq(mandates.id, real))
      .returning();
    await testDb
      .update(user)
      .set({ email: `${ulid()}@gmail.com` })
      .where(eq(user.id, realMandate?.userId as string));
    const person = await insert(STORE, "DENIED", real);
    for (const id of [sandbox, unpaid, another, person]) {
      expect((await demo.request(`/v1/alibis/${id}`)).status).toBe(404);
    }
    const ids = (await listed()).map((p) => p.id);
    expect(ids.some((id) => [sandbox, unpaid, another, person].includes(id))).toBe(false);
  });
});
