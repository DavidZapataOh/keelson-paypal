import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  passkeyPublicKey,
  type SignedAssertion,
  toAssertion,
  userKeyHash,
  verdictVerifierAbi,
} from "@keelson/chain";
import { cartHash } from "@keelson/core";
import { type Countersign, KEELSON_TYPES, keelsonDomain } from "@keelson/core/eip712";
import { eq, mandates, operators, user } from "@keelson/db";
import { closeMandate, hSd, mandateChallenge } from "@keelson/mandate";
import { pino } from "pino";
import { ulid } from "ulid";
import {
  type Address,
  bytesToHex,
  createPublicClient,
  type Hex,
  hashStruct,
  hashTypedData,
  hexToBytes,
  http,
} from "viem";
import { arbitrumSepolia } from "viem/chains";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { LegClient } from "../src/tee/client.ts";
import { createTee, VERIFYING_CONTRACT } from "../src/tee/config.ts";
import { refreshLeg } from "../src/tee/signers.ts";
import { EvidenceUploader } from "./evidence.ts";
import { testDb, testKv } from "./setup.ts";
import {
  asAgent,
  asUser,
  carts,
  headerPrincipal,
  live,
  liveEnv,
  type Passkey,
  SpcPasskey,
  seedUser,
  signedMandate,
  VirtualPasskey,
} from "./tee-live.ts";

const registryUrl = new URL("../../../contracts/deployments/421614.json", import.meta.url);
const vectorsDir = new URL(
  process.env.KEELSON_VECTORS_DIR
    ? `file://${process.env.KEELSON_VECTORS_DIR.replace(/\/?$/, "/")}`
    : "../../../contracts/test/vectors/",
  import.meta.url,
);
const registry = JSON.parse(readFileSync(registryUrl, "utf8")) as {
  demo: { agentId: number };
};
const AGENT_ID = BigInt(registry.demo.agentId);
/** The vault the coverage is locked in: `KeelsonBondVaultPreview`'s CREATE3 address. */
const VAULT = (process.env.KEELSON_BOND_VAULT ??
  "0x69ccD2fB3a85f590F2A8f431cca3ecc2e9Bf3c14") as Address;

interface Countersigned {
  mode: "2of2" | "degraded";
  decision: string;
  countersign: Record<string, string>;
  digest: Hex;
  signatures: { tdx: Hex; nitro: Hex | null };
}

describe.skipIf(!live)("coverage vectors (live legs, real passkeys)", { timeout: 300_000 }, () => {
  const tee = createTee(liveEnv(), { a: 10_000, b: 10_000 });
  const log = pino({ level: "silent" });
  const appWith = (client = tee.client) =>
    createApp({
      db: testDb,
      kv: testKv,
      log,
      appOrigin: "https://app.keelson.finance",
      authenticate: headerPrincipal,
      tee: { ...tee, client },
      requestTimeoutMs: 60_000,
    });
  const app = appWith();
  const evidence = new EvidenceUploader();
  const chain = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(process.env.ARBITRUM_SEPOLIA_RPC_URL),
  });
  const passkeys: Passkey[] = [];

  beforeAll(async () => {
    await refreshLeg(testDb, "a", tee);
    await refreshLeg(testDb, "b", tee);
    await testDb
      .insert(operators)
      .values({ agentId: AGENT_ID, chainId: arbitrumSepolia.id, name: "Demo operator", cnfJwk: {} })
      .onConflictDoNothing();
  }, 120_000);
  afterAll(async () => {
    await Promise.all(passkeys.map((p) => p.close()));
    await evidence.close();
  });

  const post = (target: ReturnType<typeof appWith>, path: string, body: unknown, headers: object) =>
    target.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...headers },
      body: JSON.stringify(body),
    });

  let mandateId: string | undefined;

  /**
   * Signs the demo mandate naming the demo operator with `passkey` and countersigns the demo cart.
   * The first mandate goes through `POST /v1/mandates`. The sandbox authorization holds funds for
   * the demo mandate id only, so later mandates, which share that id, are issued by leg A directly
   * and replace the stored one, as the countersign suite does.
   */
  async function capture(passkey: Passkey, legs = tee.client) {
    passkeys.push(passkey);
    const signed = await signedMandate(passkey, undefined, {
      agentId: AGENT_ID,
      vault: `eip155:${arbitrumSepolia.id}:${VAULT}`,
    });
    let openMandate: string;
    if (mandateId === undefined) {
      await seedUser(testDb, passkey, signed.sub);
      const created = await post(app, "/v1/mandates", signed.body, asUser(signed.sub));
      const stored = (await created.json()) as { id: string; openMandate: string };
      expect(created.status, JSON.stringify(stored)).toBe(201);
      mandateId = stored.id;
      openMandate = stored.openMandate;
    } else {
      const issued = await tee.client.a.registerMandate({
        sub: signed.sub,
        payload_sd: signed.body.payloadSd,
        disclosures: signed.body.disclosures,
        assertion: signed.assertion,
        salt: `0x${signed.salt.toString("hex")}`,
      });
      await testDb
        .insert(user)
        .values({ id: signed.sub, name: "Tester", email: `${signed.sub}@example.test` });
      await testDb
        .update(mandates)
        .set({
          userId: signed.sub,
          openMandate: issued.open_mandate,
          mandateHash: Buffer.from(hexToBytes(issued.mandate_hash as Hex)),
        })
        .where(eq(mandates.id, mandateId));
      openMandate = issued.open_mandate;
    }
    const mandate = { id: mandateId, openMandate };

    const requestId = ulid();
    const cart = carts.demo;
    const res = await post(
      appWith(legs),
      "/v1/countersign",
      {
        authorizationId: process.env.PAYPAL_AUTHORIZATION_CREATED as string,
        closedMandate: await closeMandate(
          mandate.openMandate,
          { requestId, cartHash: `sha256:${bytesToHex(cartHash(cart.cart)).slice(2)}` },
          signed.key,
        ),
        cart: cart.cart,
        unit: cart.unit,
        evidenceRoot: await evidence.upload(app, mandate.id, cart.cart, asAgent),
      },
      asAgent,
    );
    const out = (await res.json()) as Countersigned;
    expect(res.status, JSON.stringify(out).slice(0, 400)).toBe(200);
    expect(out.decision, `failedFieldsMask ${out.countersign.failedFieldsMask}`).toBe("allow");
    return { signed, out };
  }

  async function check(
    name: string,
    { signed, out }: Awaited<ReturnType<typeof capture>>,
    mode: Countersigned["mode"],
    type: string,
  ) {
    expect(out.mode).toBe(mode);
    const h = hSd(signed.body.payloadSd);
    const m = mandateChallenge(h, BigInt(signed.body.commitment));
    const cs = Object.fromEntries(
      KEELSON_TYPES.Countersign.map(({ name, type }) => {
        const v = out.countersign[name] as string;
        return [name, type.startsWith("uint") ? BigInt(v) : v];
      }),
    ) as unknown as Countersign;
    expect(cs.mandateHash).toBe(bytesToHex(m));
    expect(cs.agentId).toBe(AGENT_ID);

    const structHash = hashStruct({ data: cs, primaryType: "Countersign", types: KEELSON_TYPES });
    const digest = await chain.readContract({
      address: VERIFYING_CONTRACT,
      abi: verdictVerifierAbi,
      functionName: "hashTypedData",
      args: [structHash],
    });
    expect(digest).toBe(out.digest);
    expect(
      hashTypedData({
        domain: keelsonDomain(arbitrumSepolia.id, VERIFYING_CONTRACT),
        types: KEELSON_TYPES,
        primaryType: "Countersign",
        message: cs,
      }),
    ).toBe(digest);
    const ok =
      mode === "2of2"
        ? await chain.readContract({
            address: VERIFYING_CONTRACT,
            abi: verdictVerifierAbi,
            functionName: "verify2of2",
            args: [digest, `${out.signatures.tdx}${out.signatures.nitro?.slice(2)}` as Hex],
          })
        : await chain.readContract({
            address: VERIFYING_CONTRACT,
            abi: verdictVerifierAbi,
            functionName: "verifyDegraded",
            args: [digest, out.signatures.tdx],
          });
    expect(ok).toBe(true);

    const assertion: SignedAssertion = signed.body.assertion;
    const encoded = toAssertion(assertion);
    expect(JSON.parse(encoded.clientDataJSON).type).toBe(type);
    const cred = signed.body.disclosures
      .map((d) => JSON.parse(Buffer.from(d, "base64url").toString()) as unknown[])
      .find((d) => d[1] === "cred");
    if (!cred) throw new Error("the mandate discloses no passkey");
    const { qx, qy } = passkeyPublicKey(
      (cred[2] as { jwk: { kty: string; crv: string; x: string; y: string } }).jwk,
    );
    const vector = {
      chainId: arbitrumSepolia.id,
      verifier: VERIFYING_CONTRACT,
      vault: VAULT,
      coverageId: cs.requestId,
      countersign: out.countersign,
      digest,
      mode,
      signatures: out.signatures,
      hSd: bytesToHex(h),
      cm: signed.body.commitment,
      assertion: { ...assertion, credentialId: signed.body.assertion.credentialId },
      encodedAssertion: {
        ...encoded,
        challengeIndex: Number(encoded.challengeIndex),
        typeIndex: Number(encoded.typeIndex),
      },
      qx,
      qy,
      userKeyHash: userKeyHash(qx, qy),
    };
    if (process.env.KEELSON_WRITE_VECTORS === "1") {
      mkdirSync(vectorsDir, { recursive: true });
      writeFileSync(new URL(`${name}.json`, vectorsDir), `${JSON.stringify(vector, null, 2)}\n`);
    }
  }

  test("an SPC-signed mandate countersigned 2-of-2", async () => {
    await check(
      "coverage-2of2-payment",
      await capture(await SpcPasskey.create()),
      "2of2",
      "payment.get",
    );
  });

  test("a WebAuthn-signed mandate countersigned 2-of-2", async () => {
    await check(
      "coverage-2of2-webauthn",
      await capture(await VirtualPasskey.create()),
      "2of2",
      "webauthn.get",
    );
  });

  test("a WebAuthn-signed mandate countersigned by leg A alone while leg B is unreachable", async () => {
    const down = new LegClient(
      "b",
      "http://127.0.0.1:9",
      process.env.KEELSON_TEE_TOKEN as string,
      500,
    );
    await check(
      "coverage-degraded",
      await capture(await VirtualPasskey.create(), { a: tee.client.a, b: down }),
      "degraded",
      "webauthn.get",
    );
  });
});
