// Loads reflect-metadata before @keelson/alibi/verify pulls in @keelson/attest (see tee/attest.ts).
import "../src/tee/attest.ts";
import { randomBytes } from "node:crypto";
import { decodeAlibi, leafHashOf } from "@keelson/alibi";
import { verifyAlibi } from "@keelson/alibi/verify";
import { alibis, eq, mandates, purchases, sql, user } from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import { beforeAll, describe, expect, test } from "vitest";
import { fixtures } from "../../../packages/alibi/test/fixtures.ts";
import { createApp } from "../src/app.ts";
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
    expect(bundle.paypal.transaction_id).toBe("5MC585209K746392H");
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
    const pdf = await app.request(`/v1/alibis/${b.alibi_id}.pdf`);
    expect(pdf.status).toBe(200);
    expect(Buffer.from(await pdf.arrayBuffer()).toString("latin1")).not.toContain(login);
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
