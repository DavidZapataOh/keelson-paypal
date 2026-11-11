import { randomBytes } from "node:crypto";
import { leafHashOf } from "@keelson/alibi";
import { alibis, eq, evidenceBundles, mandates, operators, purchases, user } from "@keelson/db";
import {
  type EcPublicJwk,
  jwtPayload,
  type Signer,
  signerOf,
  verifyAgentRequest,
} from "@keelson/interop";
import { exportJWK, generateKeyPair } from "jose";
import { pino } from "pino";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { copy, fixtures } from "../../../packages/alibi/test/fixtures.ts";
import { createApp } from "../src/app.ts";
import { testDb, testKv } from "./setup.ts";
import { asUser, headerPrincipal } from "./tee-live.ts";

async function freshSigner(): Promise<Signer> {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  return signerOf(privateKey, (await exportJWK(publicKey)) as EcPublicJwk);
}

const keelson = await freshSigner();
const hosted = await freshSigner();
const f = fixtures[1];
const owner = `user-${randomBytes(6).toString("hex")}`;

/**
 * The fixture's mandate delegates to Keelson's hosted operator, whose key stays on the API: the
 * stored copy names this test's hosted key instead, so the export can close it.
 */
function delegatedToHosted() {
  const b = copy(f?.bundle as NonNullable<typeof f>["bundle"]);
  const cnf = { jwk: { ...hosted.jwk, kid: hosted.kid } };
  const sd = b.mandate.payload_sd as { agent: { cnf: unknown }; cnf: unknown };
  sd.agent.cnf = cnf;
  sd.cnf = cnf;
  return b;
}

const app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  authenticate: headerPrincipal,
  exportSigner: keelson,
  hostedAgent: hosted,
});
const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });

describe.skipIf(!f)("export routes", () => {
  const b = delegatedToHosted();
  const id = b.alibi_id;
  let mandateId = "";

  beforeAll(async () => {
    const c = b.tee.countersign;
    await testDb.insert(user).values({ id: owner, name: "Tester", email: `${owner}@example.test` });
    await testDb
      .insert(operators)
      .values({
        agentId: BigInt(c.agentId),
        chainId: 421614,
        agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
        name: "op",
        cnfJwk: {},
      })
      .onConflictDoNothing();
    mandateId = ulid();
    await testDb.insert(mandates).values({
      id: mandateId,
      userId: owner,
      operatorAgentId: BigInt(c.agentId),
      state: "ACTIVE",
      currency: "USD",
      maxMinor: 10_000n,
      remainingMinor: 9_800n,
      merchantIds: ["mrc_runfast"],
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await testDb
      .insert(evidenceBundles)
      .values({
        root: Buffer.from(c.evidenceRoot.slice(2), "hex"),
        mandateId,
        manifest: b.manifest.public,
        uploadedBy: "operator-client",
      })
      .onConflictDoNothing();
    await testDb.insert(purchases).values({
      id,
      mandateId,
      clientId: "operator-client",
      state: "CAPTURED",
      merchantId: String(b.eval.context.merchant),
      currency: "USD",
      amountMinor: BigInt(c.amount),
      cartHash: Buffer.from(c.cartHash.slice(2), "hex"),
      paypalCaptureId: b.paypal?.capture_id ?? null,
    });
    const { timestamps: _t, anchor: _a, ...core } = b;
    await testDb.insert(alibis).values({
      purchaseId: id,
      leafHash: Buffer.from(leafHashOf(b)),
      bundle: { ...core, timestamps: [] },
      ...(b.anchor ? { anchor: b.anchor } : {}),
    });
  });

  afterAll(async () => {
    await testDb.delete(alibis).where(eq(alibis.purchaseId, id));
    await testDb.delete(purchases).where(eq(purchases.id, id));
  });

  test("publishes the export key as a JWK set", async () => {
    const res = await get("/.well-known/jwks.json");
    expect(await res.json()).toEqual({
      keys: [{ ...keelson.jwk, kid: keelson.kid, alg: "ES256", use: "sig" }],
    });
  });

  test("exports AP2 v0.2 open and closed mandates with receipts, closed by the hosted agent", async () => {
    const res = await get(`/v1/alibis/${id}/exports/ap2?nonce=n-1`, asUser(owner));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${id}.ap2.json"`);
    const body = (await res.json()) as {
      open: { checkout: string };
      closed: { checkout: string; payment: string };
      receipts: { payment: string };
    };
    const hop = (body.closed.checkout.split("~~")[1] as string).split("~")[0] as string;
    expect(JSON.parse(atob(hop.split(".")[0] as string))).toMatchObject({
      typ: "kb+sd-jwt",
      kid: hosted.kid,
    });
    expect(jwtPayload(hop)).toMatchObject({ aud: "https://runfast.example", nonce: "n-1" });
    expect(jwtPayload(body.receipts.payment)).toMatchObject({
      status: "Success",
      iss: "https://keelson.finance",
    });
  });

  test("exports Verifiable Intent L1, L2 and L3", async () => {
    const body = (await (await get(`/v1/alibis/${id}/exports/vi`, asUser(owner))).json()) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining(["l1", "l2", "l2Payment", "l2Checkout", "l3"]),
    );
    expect(body.l3).toMatchObject({
      l3Payment: expect.any(String),
      l3Checkout: expect.any(String),
    });
  });

  test("exports the ACP allowance with the budget left when the purchase was countersigned", async () => {
    const body = (await (await get(`/v1/alibis/${id}/exports/acp`, asUser(owner))).json()) as {
      allowance: { max_amount: number; currency: string };
      metadata: Record<string, string>;
    };
    expect(body.allowance).toMatchObject({
      reason: "one_time",
      currency: "usd",
      max_amount: 9_800 + Number(b.tee.countersign.amount),
    });
    expect(body.metadata).toEqual({ keelson_alibi: id });
  });

  test("exports a TAP request the agent signed over Keelson-Alibi", async () => {
    const body = (await (await get(`/v1/alibis/${id}/exports/tap`, asUser(owner))).json()) as {
      request: { method: string; url: string };
      headers: Record<string, string>;
    };
    const request = new Request(body.request.url, {
      method: body.request.method,
      headers: body.headers,
    });
    const verified = await verifyAgentRequest(request, async () => hosted.jwk, {
      now: Number(b.tee.countersign.issuedAt),
      requireAlibi: true,
    });
    expect(verified.parameters.tag).toBe("agent-payer-auth");
  });

  test("exports the Visa evidence pack with the CE3.0 elements only for the mandate's user", async () => {
    const mine = (await (await get(`/v1/alibis/${id}/exports/visa`, asUser(owner))).json()) as {
      ce3: { elements: { status: string }[] };
    };
    expect(mine.ce3.elements[0]?.status).toBe("provided");
    const other = await get(`/v1/alibis/${id}/exports/visa`, asUser("someone-else"));
    expect(other.status).toBe(404);
  });

  test("renders the evidence pack as a PDF", async () => {
    const res = await get(`/v1/alibis/${id}/exports/visa.pdf`, asUser(owner));
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const pdf = Buffer.from(await res.arrayBuffer());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.includes(`${id}.evidence.json`)).toBe(true);
  });

  test("answers 404 for an unknown format and 503 without the export key", async () => {
    expect((await get(`/v1/alibis/${id}/exports/x402`, asUser(owner))).status).toBe(422);
    const bare = createApp({
      db: testDb,
      kv: testKv,
      log: pino({ level: "silent" }),
      authenticate: headerPrincipal,
    });
    expect(
      (await bare.request(`/v1/alibis/${id}/exports/ap2`, { headers: asUser(owner) })).status,
    ).toBe(503);
  });
});
