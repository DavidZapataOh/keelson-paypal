import { type Json, jcs, sha256, toHex } from "@keelson/core";
import { hashKeelson, keelsonDomain, reportData } from "@keelson/core/eip712";
import { buildSdPayload, parseMandate } from "@keelson/mandate";
import { keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vitest";
import demo from "../../mandate/test/fixtures/demo-mandate.json" with { type: "json" };
import type { AlibiBundle } from "../src/schema.ts";
import { webFact } from "../src/verify/checks/web-fact.ts";
import { bindWebFact } from "../src/web-fact.ts";

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

/** The demo mandate, allowing Alfred Music at its website. */
async function mandate(website = "https://www.alfred.com") {
  const m = parseMandate(structuredClone(demo));
  for (const c of m.checkout.constraints) {
    if (c.type === "checkout.allowed_merchants") {
      c.allowed = [
        { id: "mrc_alfred", name: "Alfred Music", website, paypal_merchant_id: "unknown" },
      ];
    }
  }
  const { payloadSd, disclosures } = await buildSdPayload(m, () =>
    crypto.getRandomValues(new Uint8Array(16)),
  );
  return { payload_sd: payloadSd, disclosures };
}
const alfred = await mandate();
const offer = (o: Record<string, unknown> = {}) =>
  new TextEncoder().encode(
    JSON.stringify({
      title: "Default Title",
      offer_id: 44631538991240,
      sku: "00-PS-0004070",
      price: 2.95,
      currency_code: "USD",
      in_stock: true,
      ...o,
    }),
  );
const committed = offer();
const blinder = new Uint8Array(16).fill(5);
const ISSUED_AT = 1_794_300_060;
const LINE = /not a line of the cart/;
const TIME = /not notarized for this purchase/;
const cart = {
  merchant: "mrc_alfred",
  currency: "USD",
  lines: [
    {
      sku: "00-PS-0004070",
      size: null,
      color: null,
      category: "gpt:783",
      qty: 2,
      unit_minor: 295,
    },
  ],
  return_days: 0,
  returns_free: false,
};

async function signedDoc(bytes = committed, tCapture = 1_794_300_000, at = URL_) {
  const url = new URL(at);
  const fact = {
    hostHash: keccak256(stringToHex(url.hostname)),
    urlPathHash: keccak256(stringToHex(`${url.pathname}${url.search}`)),
    tCapture,
    rangeCommitment: toHex(sha256(new Uint8Array([...bytes, ...blinder]))),
    attId: reportData(
      { ...binding, chainId: 421614n, bootEpoch: 7n },
      `0x${"00".repeat(32)}`,
    ).slice(0, 66) as `0x${string}`,
  };
  const digest = hashKeelson("WebFact", fact, keelsonDomain(421614, VERIFYING));
  return {
    url: at,
    web_fact: fact,
    chain_id: 421614,
    digest,
    signature: await account.sign({ hash: digest }),
    signer: account.address,
    mode: "mpc",
    range: [10, 10 + bytes.length],
    committed: toHex(bytes),
    blinder: toHex(blinder),
  };
}

const bundleWith = (
  doc: Record<string, unknown>,
  hash = toHex(sha256(new TextEncoder().encode(jcs(doc as Json)))),
  withCart: Record<string, unknown> | undefined = cart,
  m: Awaited<ReturnType<typeof mandate>> = alfred,
) =>
  ({
    type: "application/vnd.keelson.alibi.v1+json",
    tee: {
      domain: { name: "Keelson", version: "1", chain_id: 421614, verifying_contract: VERIFYING },
      countersign: { issuedAt: String(ISSUED_AT) },
      attestations: [{ kind: "tdx", signer: account.address, binding }],
    },
    mandate: m,
    manifest: {
      public: { items: [{ type: "tlsn.web_fact" }] },
      disclosures: [{ type: "tlsn.web_fact", content_hash: hash }],
    },
    ...(withCart ? { cart: withCart } : {}),
    web_fact: doc,
  }) as unknown as AlibiBundle;

const run = (b: AlibiBundle) =>
  webFact.run(b, { now: new Date(), expect: undefined, chain: null } as never);

describe("the store's product endpoint, notarized", () => {
  test("a WebFact leg A signed over the disclosed bytes passes", async () => {
    expect(await run(bundleWith(await signedDoc()))).toMatchObject({ status: "pass" });
  });

  test("an Alibi without one has the check absent", async () => {
    const b = bundleWith(await signedDoc()) as unknown as {
      web_fact?: unknown;
      manifest: { public: { items: unknown[] } };
    };
    delete b.web_fact;
    b.manifest.public.items = [];
    expect(await run(b as unknown as AlibiBundle)).toMatchObject({ status: "absent" });
  });

  test("an Alibi that leaves out the WebFact its evidence holds has it undisclosed", async () => {
    const b = bundleWith(await signedDoc()) as unknown as Record<string, unknown>;
    delete b.web_fact;
    expect(await run(b as unknown as AlibiBundle)).toMatchObject({ status: "undisclosed" });
  });

  test("a WebFact of another line of the cart passes and names that line", async () => {
    const two = {
      ...cart,
      lines: [{ ...cart.lines[0], sku: "00-OTHER", unit_minor: 100 }, ...cart.lines],
    };
    expect(await run(bundleWith(await signedDoc(), undefined, two))).toMatchObject({
      status: "pass",
      detail: { sku: "00-PS-0004070" },
    });
  });

  test.each([
    ["another host", "https://alfred.example/products/the-change-00-ps-0004070.oembed"],
    ["another path", "https://www.alfred.com/products/the-change-00-ps-0004070.js"],
    ["a query", "https://www.alfred.com/products/the-change-00-ps-0004070.oembed?x=1"],
  ])("a WebFact of %s fails", async (_, url) => {
    await expect(run(bundleWith(await signedDoc(committed, undefined, url)))).rejects.toThrow(
      /store the mandate allows/,
    );
  });

  test("a WebFact under a mandate that allows the merchant at another website fails", async () => {
    const other = await mandate("https://shop.alfred.example");
    await expect(run(bundleWith(await signedDoc(), undefined, cart, other))).rejects.toThrow(
      /store the mandate allows/,
    );
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

  test("a line named by the variant id does not take an offer with its own SKU", async () => {
    const byId = { ...cart, lines: [{ ...cart.lines[0], sku: "44631538991240" }] };
    await expect(run(bundleWith(await signedDoc(), undefined, byId))).rejects.toThrow(LINE);
  });

  test("a WebFact whose offer names the line by its variant id passes", async () => {
    const byId = { ...cart, lines: [{ ...cart.lines[0], sku: "44631538991240" }] };
    const doc = await signedDoc(offer({ sku: "" }));
    expect(await run(bundleWith(doc, undefined, byId))).toMatchObject({ status: "pass" });
  });

  test.each([
    ["another product", () => signedDoc(offer({ offer_id: 1, sku: "00-PS-0009999" })), LINE],
    ["another price", () => signedDoc(offer({ price: 0.99 })), LINE],
    ["another currency", () => signedDoc(offer({ currency_code: "EUR" })), LINE],
    ["a price as text", () => signedDoc(offer({ price: "2.95" })), LINE],
    [
      "bytes that are not an offer",
      () => signedDoc(new TextEncoder().encode('"offer_id":1')),
      /not one offer/,
    ],
    ["a stale notarization", () => signedDoc(committed, ISSUED_AT - 901), TIME],
    ["a notarization after the countersign", () => signedDoc(committed, ISSUED_AT + 61), TIME],
  ])("a WebFact of %s fails", async (_, doc, reason) => {
    await expect(run(bundleWith(await doc()))).rejects.toThrow(reason);
  });

  test("a WebFact without the cart it is for fails", async () => {
    await expect(run(bundleWith(await signedDoc(), undefined, null as never))).rejects.toThrow(
      /cart/,
    );
  });

  test("a document that is not the disclosed item fails", async () => {
    await expect(run(bundleWith(await signedDoc(), `0x${"ab".repeat(32)}`))).rejects.toThrow();
  });
});

describe("a store's variant JSON, notarized", () => {
  const STORE = "https://store.keelson.finance";
  const PAGE = `${STORE}/api/products/tempo-3/variants/RF-TMP3-11`;
  const runFast = {
    merchant: "mrc_runfast",
    currency: "USD",
    lines: [
      {
        sku: "RF-TMP3-11",
        size: "11",
        color: "blue",
        category: "gpt:187",
        qty: 1,
        unit_minor: 12900,
      },
    ],
    return_days: 30,
    returns_free: true,
  };
  const variant = (o: Record<string, unknown> = {}) =>
    toHex(
      new TextEncoder().encode(
        JSON.stringify({
          sku: "RF-TMP3-11",
          size: "11",
          color: "blue",
          unit_minor: 12900,
          returns_free: true,
          ...o,
        }),
      ),
    ).slice(2);
  const doc = (committed: string, url = PAGE) => ({
    url,
    web_fact: { tCapture: ISSUED_AT - 30 },
    committed,
  });

  test("the variant the cart's line names, at its price, binds to the line", () => {
    expect(bindWebFact(doc(variant()), runFast, STORE, ISSUED_AT)).toEqual({
      line: runFast.lines[0],
    });
  });

  test.each([
    ["another SKU than its URL names", doc(variant({ sku: "RF-TMP3-10" }))],
    ["another price", doc(variant({ unit_minor: 9900 }))],
    ["a price as text", doc(variant({ unit_minor: "12900" }))],
    [
      "a page of another store",
      doc(variant(), "https://store.example/api/products/tempo-3/variants/RF-TMP3-11"),
    ],
    ["a query", doc(variant(), `${PAGE}?size=11`)],
    ["a nested path", doc(variant(), `${STORE}/api/products/tempo-3/variants/RF-TMP3-11/x`)],
  ])("a variant JSON of %s does not bind", (_, d) => {
    expect(bindWebFact(d, runFast, STORE, ISSUED_AT)).toHaveProperty("reason");
  });
});
