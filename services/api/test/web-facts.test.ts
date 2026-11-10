import { hashKeelson, keelsonDomain, reportData } from "@keelson/core/eip712";
import { pino } from "pino";
import { type Hex, keccak256, stringToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { VERIFYING_CONTRACT } from "../src/tee/config.ts";
import { type SignedWebFact, verifyWebFact } from "../src/web-fact.ts";
import { asClient } from "./channel3.ts";
import { testDb, testKv } from "./setup.ts";
import { headerPrincipal } from "./tee-live.ts";

const agent = asClient("web-fact-agent");
const URL_ = "https://store.keelson.finance/api/products/tempo-3";

const appWith = (prover?: string) =>
  createApp({
    db: testDb,
    kv: testKv,
    log: pino({ level: "silent" }),
    authenticate: headerPrincipal,
    ...(prover ? { prover } : {}),
  });

const post = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request("/v1/observations/web-fact", {
    method: "POST",
    headers: { "content-type": "application/json", ...agent },
    body: JSON.stringify(body),
  });

describe("POST /v1/observations/web-fact", () => {
  test("without a prover it answers 503", async () => {
    const res = await post(appWith(), { url: URL_ });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { type: string }).type).toMatch(/prover-unconfigured$/);
  });

  test.each([
    "http://store.keelson.finance/api/products/tempo-3",
    "https://store.keelson.finance:8443/api/products/tempo-3",
    "https://203.0.113.7/products/x.js",
    "https://user:pass@store.keelson.finance/api/products/tempo-3",
    "https://localhost/products/x.js",
    "https://store.keelson.finance/api/products/tempo-3#x",
  ])("refuses %s", async (url) => {
    const res = await post(appWith("http://127.0.0.1:9"), { url });
    expect(res.status).toBe(422);
  });
});

describe("verifyWebFact", () => {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  const binding = {
    chainId: "421614",
    bondVault: "0xb39898Ef4333f3CB32d1B420E744f5a1Aa2ae2Bf",
    teeKind: 1,
    signer: account.address,
    policySetHash: `0x${"11".repeat(32)}`,
    engineBuildId: `0x${"22".repeat(32)}`,
    bootEpoch: "7",
    issuerJwkThumbprint: `0x${"33".repeat(32)}`,
  } as const;
  const attId = reportData(
    { ...binding, chainId: 421614n, bootEpoch: 7n, teeKind: 1 },
    `0x${"00".repeat(32)}`,
  ).slice(0, 66) as Hex;

  async function signed(over: Partial<SignedWebFact["web_fact"]> = {}): Promise<SignedWebFact> {
    const web_fact = {
      hostHash: keccak256(stringToHex("store.keelson.finance")),
      urlPathHash: keccak256(stringToHex("/api/products/tempo-3")),
      tCapture: 1_794_000_000,
      rangeCommitment: `0x${"44".repeat(32)}` as Hex,
      attId,
      ...over,
    };
    const digest = hashKeelson("WebFact", web_fact, keelsonDomain(421614, VERIFYING_CONTRACT));
    const signature = await account.sign({ hash: digest });
    return { web_fact, chain_id: 421614, digest, signature, signer: account.address };
  }
  const signer = { address: account.address, binding };

  test("accepts a fact over the URL signed by the active signer", async () => {
    await expect(
      verifyWebFact(await signed(), new URL(URL_), signer, VERIFYING_CONTRACT),
    ).resolves.toBeUndefined();
  });

  test("refuses another URL, another signer, a stale attestation or a forged digest", async () => {
    const fact = await signed();
    await expect(
      verifyWebFact(fact, new URL(`${URL_}?x=1`), signer, VERIFYING_CONTRACT),
    ).rejects.toMatchObject({ code: "url" });
    const other = privateKeyToAccount(generatePrivateKey()).address;
    await expect(
      verifyWebFact(fact, new URL(URL_), { address: other, binding }, VERIFYING_CONTRACT),
    ).rejects.toMatchObject({ code: "signer" });
    await expect(
      verifyWebFact(
        await signed({ attId: `0x${"55".repeat(32)}` }),
        new URL(URL_),
        signer,
        VERIFYING_CONTRACT,
      ),
    ).rejects.toMatchObject({ code: "attestation" });
    await expect(
      verifyWebFact(
        { ...fact, digest: `0x${"66".repeat(32)}` },
        new URL(URL_),
        signer,
        VERIFYING_CONTRACT,
      ),
    ).rejects.toMatchObject({ code: "signature" });
  });
});
