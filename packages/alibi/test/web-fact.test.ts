import { type Json, jcs, sha256, toHex } from "@keelson/core";
import { hashKeelson, keelsonDomain, reportData } from "@keelson/core/eip712";
import { keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vitest";
import type { AlibiBundle } from "../src/schema.ts";
import { webFact } from "../src/verify/checks/web-fact.ts";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const VERIFYING = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const binding = {
  chainId: "421614",
  bondVault: "0x0000000000000000000000000000000000000001",
  teeKind: 1,
  signer: account.address,
  policySetHash: `0x${"22".repeat(32)}`,
  engineBuildId: `0x${"33".repeat(32)}`,
  bootEpoch: "7",
  issuerJwkThumbprint: `0x${"44".repeat(32)}`,
} as const;
const URL_ = "https://www.alfred.com/products/the-change-00-ps-0004070.oembed";
const committed = new TextEncoder().encode('{"offer_id":44631538991240,"price":2.95}');
const blinder = new Uint8Array(16).fill(5);

async function signedDoc() {
  const url = new URL(URL_);
  const fact = {
    hostHash: keccak256(stringToHex(url.hostname)),
    urlPathHash: keccak256(stringToHex(`${url.pathname}${url.search}`)),
    tCapture: 1_794_300_000,
    rangeCommitment: toHex(sha256(new Uint8Array([...committed, ...blinder]))),
    attId: reportData(
      { ...binding, chainId: 421614n, bootEpoch: 7n },
      `0x${"00".repeat(32)}`,
    ).slice(0, 66) as `0x${string}`,
  };
  const digest = hashKeelson("WebFact", fact, keelsonDomain(421614, VERIFYING));
  return {
    url: URL_,
    web_fact: fact,
    chain_id: 421614,
    digest,
    signature: await account.sign({ hash: digest }),
    signer: account.address,
    mode: "mpc",
    range: [10, 10 + committed.length],
    committed: toHex(committed),
    blinder: toHex(blinder),
  };
}

const bundleWith = (
  doc: Record<string, unknown>,
  hash = toHex(sha256(new TextEncoder().encode(jcs(doc as Json)))),
) =>
  ({
    type: "application/vnd.keelson.alibi.v1+json",
    tee: {
      domain: { name: "Keelson", version: "1", chain_id: 421614, verifying_contract: VERIFYING },
      attestations: [{ kind: "tdx", signer: account.address, binding }],
    },
    manifest: { disclosures: [{ type: "tlsn.web_fact", content_hash: hash }] },
    web_fact: doc,
  }) as unknown as AlibiBundle;

const run = (b: AlibiBundle) =>
  webFact.run(b, { now: new Date(), expect: undefined, chain: null } as never);

describe("the store's product endpoint, notarized", () => {
  test("a WebFact leg A signed over the disclosed bytes passes", async () => {
    expect(await run(bundleWith(await signedDoc()))).toMatchObject({ status: "pass" });
  });

  test("an Alibi without one has the check absent", async () => {
    const b = bundleWith(await signedDoc()) as unknown as Record<string, unknown>;
    delete b.web_fact;
    expect(await run(b as unknown as AlibiBundle)).toMatchObject({ status: "absent" });
  });

  test.each([
    [
      "committed bytes",
      (d: Record<string, unknown>) => ({
        ...d,
        committed: toHex(new TextEncoder().encode('{"price":0.01}')),
      }),
    ],
    [
      "URL",
      (d: Record<string, unknown>) => ({
        ...d,
        url: "https://www.alfred.com/products/other.oembed",
      }),
    ],
    [
      "signer",
      (d: Record<string, unknown>) => ({
        ...d,
        signer: "0x0000000000000000000000000000000000000009",
      }),
    ],
  ])("a tampered %s fails", async (_, tamper) => {
    const doc = tamper(await signedDoc());
    await expect(run(bundleWith(doc))).rejects.toThrow();
  });

  test("a document that is not the disclosed item fails", async () => {
    await expect(run(bundleWith(await signedDoc(), `0x${"ab".repeat(32)}`))).rejects.toThrow();
  });
});
