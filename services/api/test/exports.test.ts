import { randomBytes } from "node:crypto";
import { leafHashOf, registeredOf } from "@keelson/alibi";
import { alibis, eq, mandates, purchases } from "@keelson/db";
import { purchaseFacts, statementFacts, verifyExport } from "@keelson/interop";
import { localExportSigner } from "@keelson/interop/testing";
import { exportJWK, generateKeyPair } from "jose";
import { pino } from "pino";
import { ulid } from "ulid";
import { beforeAll, describe, expect, test } from "vitest";
import { fixtures } from "../../../packages/alibi/test/fixtures.ts";
import { receiptKeys, v2Bundle } from "../../../packages/alibi/test/v2.ts";
import { createApp } from "../src/app.ts";
import { channel3Mandate } from "./channel3.ts";
import { testDb, testKv } from "./setup.ts";
import { asUser, headerPrincipal } from "./tee-live.ts";

const core = v2Bundle();
const id = ulid();
const bundle = { ...core, alibi_id: id };
const { privateKey } = await generateKeyPair("ES256", { extractable: true });
const issuer = await localExportSigner(await exportJWK(privateKey), () =>
  statementFacts(purchaseFacts(bundle)),
);
const deps = {
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  authenticate: headerPrincipal,
};
const app = createApp({ ...deps, exportIssuer: issuer });
const now = Date.parse("2026-11-11T20:00:00Z") / 1000;
const verified = (body: unknown) =>
  verifyExport(body, { now, issuerKeys: [issuer.jwk], receiptKeys });

async function purchase(id: string, statement?: Uint8Array) {
  const mandateId = await channel3Mandate();
  const [m] = await testDb.select().from(mandates).where(eq(mandates.id, mandateId));
  await testDb.insert(purchases).values({
    id,
    mandateId,
    clientId: "observer-agent",
    state: "LOGGED",
    merchantId: "store",
    currency: "USD",
    amountMinor: 100n,
    cartHash: randomBytes(32),
    ...(statement ? { statement: Buffer.from(statement) } : {}),
  });
  return asUser(m?.userId as string);
}

describe("Alibi exports", () => {
  let as: Record<string, string>;
  beforeAll(async () => {
    as = await purchase(id, registeredOf(core));
    await testDb
      .insert(alibis)
      .values({ purchaseId: id, leafHash: Buffer.from(leafHashOf(core)), bundle });
  });

  test.each(["ap2", "vi", "acp", "visa"])(
    "%s is served signed by the issuer and verifies offline",
    async (format) => {
      const res = await app.request(`/v1/alibis/${id}/exports/${format}`, { headers: as });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(`application/vnd.keelson.${format}+json`);
      const r = await verified(await res.json());
      expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    },
  );

  test("the evidence pack is also served as a PDF", async () => {
    const res = await app.request(`/v1/alibis/${id}/exports/visa.pdf`, { headers: as });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(
      Buffer.from(await res.arrayBuffer())
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
  });

  test("a format that cannot state the purchase answers why", async () => {
    const ucp = await app.request(`/v1/alibis/${id}/exports/ucp`, { headers: as });
    expect(ucp.status).toBe(409);
    expect(await ucp.json()).toMatchObject({ reason: "no_cart" });
    const tap = await app.request(`/v1/alibis/${id}/exports/tap`, { headers: as });
    expect(await tap.json()).toMatchObject({ reason: "no_http_key" });
  });

  test("a v1 Alibi without a bridge statement is not exported", async () => {
    const v1 = fixtures[1]?.bundle;
    if (!v1) throw new Error("no v1 fixture");
    const v1Id = ulid();
    const owner = await purchase(v1Id);
    await testDb
      .insert(alibis)
      .values({ purchaseId: v1Id, leafHash: randomBytes(32), bundle: { ...v1, alibi_id: v1Id } });
    const res = await app.request(`/v1/alibis/${v1Id}/exports/ap2`, { headers: owner });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "v1_alibi" });
  });

  test("without the enclave issuer nothing is signed", async () => {
    const res = await createApp(deps).request(`/v1/alibis/${id}/exports/ap2`, { headers: as });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: "signer_unavailable" });
  });

  test("an unknown format is refused and a stranger gets nothing", async () => {
    expect((await app.request(`/v1/alibis/${id}/exports/csv`, { headers: as })).status).toBe(422);
    expect((await app.request(`/v1/alibis/${id}/exports/ap2`)).status).toBe(404);
  });

  test("the JWKS publishes the issuer's key", async () => {
    const res = await app.request("/.well-known/jwks.json");
    expect(res.status).toBe(200);
    expect((await res.json()).keys).toContainEqual(issuer.jwk);
  });
});
