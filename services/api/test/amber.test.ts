import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { amberContradictionCourtAbi, deploymentsFor } from "@keelson/chain";
import { ulidToBytes32 } from "@keelson/core";
import { amberCommitment, amberProduct } from "@keelson/core/amber";
import {
  amberConvictions,
  disputes,
  eq,
  evidenceBundles,
  evidenceItems,
  mandates,
  operators,
  purchases,
  user,
} from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import {
  encodeFunctionData,
  type Hex,
  keccak256,
  type PublicClient,
  stringToHex,
  zeroHash,
} from "viem";
import { beforeAll, describe, expect, test } from "vitest";
import { amberCases, amberOf, fixAmber } from "../src/amber.ts";
import { createApp } from "../src/app.ts";
import {
  c2bOfCall,
  projectAmberConvictions,
  purchaseOfCoverage,
} from "../src/chain/amber-court.ts";
import { type EventLog, ingest } from "../src/chain/events.ts";
import { coverageRows } from "../src/routes/operator-console.ts";
import { testDb, testKv } from "./setup.ts";

type Vector = { proof: Hex; publicInputs: Hex[] };
const vector = (field: string): Vector =>
  JSON.parse(
    readFileSync(
      new URL(`../../../contracts/test/vectors/c2b-${field}.json`, import.meta.url),
      "utf8",
    ),
  ) as Vector;

/** The store's product and a one-line cart of it, as the agent's evidence holds them. */
const product = {
  merchant: "mrc_runfast",
  handle: "tempo-3",
  sku: "RF-TMP3",
  url: "https://store.keelson.finance/products/tempo-3",
  color: "blue",
  price: { currency: "USD", minor: 12_900, display: "$129.00" },
  sizes: ["10", "11"],
  returns_free: true,
};
const line = {
  sku: "RF-TMP3-11",
  size: "11",
  color: "blue",
  category: "apparel.footwear",
  qty: 1,
  unit_minor: 12_900,
};
const cart = {
  merchant: "mrc_runfast",
  currency: "USD",
  lines: [line],
  return_days: 30,
  returns_free: true,
};
const VARIANT = "https://store.keelson.finance/api/products/tempo-3/variants/RF-TMP3-11";

describe("amberOf", () => {
  test("attests a one-line cart at the store's JSON page for its SKU", () => {
    const a = amberOf("mrc_runfast", cart, product);
    expect(a?.url.href).toBe(VARIANT);
    expect(a?.amber).toEqual({
      sku: "RF-TMP3-11",
      size: "11",
      color: "blue",
      unitMinor: 12_900n,
      returnsFree: true,
    });
  });

  test("names the page the C2b vectors were proven of", () => {
    const a = amberOf("mrc_runfast", cart, product);
    expect(
      `0x${amberProduct(a?.url as URL)
        .toString(16)
        .padStart(64, "0")}`,
    ).toBe(vector("size").publicInputs[3]);
  });

  test("attests nothing it cannot open", () => {
    expect(amberOf("mrc_runfast", { ...cart, lines: [line, line] }, product)).toBeUndefined();
    expect(amberOf("mrc_runfast", { ...cart, lines: [{ ...line, size: null }] }, product)).toBe(
      undefined,
    );
    expect(
      amberOf("mrc_runfast", cart, { ...product, url: "https://evil.example/products/tempo-3" }),
    ).toBeUndefined();
    expect(
      amberOf("mrc_runfast", { ...cart, lines: [{ ...line, color: "x".repeat(31) }] }, product),
    ).toBeUndefined();
    expect(amberOf("mrc_elsewhere", { ...cart, merchant: "mrc_elsewhere" }, product)).toBe(
      undefined,
    );
    expect(amberOf("mrc_runfast", cart, { ...product, handle: "../admin" })).toBeUndefined();
  });

  test("attests nothing the agent's own capture of the product contradicts", () => {
    const one = (l: Partial<typeof line>) => ({ ...cart, lines: [{ ...line, ...l }] });
    expect(amberOf("mrc_runfast", one({ color: "red" }), product)).toBeUndefined();
    expect(amberOf("mrc_runfast", one({ unit_minor: 11_900 }), product)).toBeUndefined();
    expect(amberOf("mrc_runfast", one({ size: "12", sku: "RF-TMP3-12" }), product)).toBeUndefined();
    expect(amberOf("mrc_runfast", one({ sku: "RF-OTHER-11" }), product)).toBeUndefined();
    expect(amberOf("mrc_runfast", { ...cart, returns_free: false }, product)).toBeUndefined();
  });

  test("attests only the page the agent captured, of the cart's merchant", () => {
    // A handle that is not the captured page's would name a page no proof can ever read.
    expect(amberOf("mrc_runfast", cart, { ...product, handle: "ghost" })).toBeUndefined();
    expect(
      amberOf("mrc_runfast", cart, { ...product, url: `${product.url}-ghost` }),
    ).toBeUndefined();
    expect(amberOf("mrc_runfast", cart, { ...product, merchant: "mrc_other" })).toBeUndefined();
  });
});

let mandateId = "";
let agentId = 0n;

/** The `tlsn.web_fact` item of the store's answer for the variant, as the agent seals it. */
const notarized = (answer: Record<string, unknown> = {}, url = VARIANT) => ({
  url,
  committed: Buffer.from(
    JSON.stringify({
      sku: "RF-TMP3-11",
      size: "11",
      color: "blue",
      unit_minor: 12_900,
      returns_free: true,
      ...answer,
    }),
  ).toString("hex"),
});

async function purchase(
  state = "COVERED",
  evidence?: { cart: unknown; product: unknown; webFact?: unknown },
) {
  const id = ulid();
  const root = randomBytes(32);
  if (evidence) {
    await testDb
      .insert(evidenceBundles)
      .values({ root, mandateId, manifest: {}, uploadedBy: "agent" });
    const items = [
      ["api.product", evidence.product],
      ["api.cart", evidence.cart],
      ...(evidence.webFact ? [["tlsn.web_fact", evidence.webFact] as const] : []),
    ] as const;
    for (const [index, [type, value]] of items.entries()) {
      const bytes = Buffer.from(JSON.stringify(value));
      await testDb.insert(evidenceItems).values({
        root,
        index,
        type,
        mediaType: "application/json",
        contentHash: createHash("sha256").update(bytes).digest(),
        salt: randomBytes(32),
        bytes,
      });
    }
  }
  await testDb.insert(purchases).values({
    id,
    mandateId,
    merchantId: "mrc_runfast",
    currency: "USD",
    amountMinor: 12_900n,
    cartHash: randomBytes(32),
    state: state as "COVERED",
    ...(evidence ? { evidenceRoot: root } : {}),
  });
  return id;
}

beforeAll(async () => {
  const userId = ulid();
  await testDb.insert(user).values({ id: userId, name: "Buyer", email: `${userId}@example.test` });
  agentId = BigInt(Date.now());
  await testDb.insert(operators).values({
    agentId,
    chainId: 421614,
    agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    name: "op",
    cnfJwk: {},
  });
  mandateId = ulid();
  await testDb.insert(mandates).values({
    id: mandateId,
    userId,
    operatorAgentId: agentId,
    currency: "USD",
    maxMinor: 20_000n,
    remainingMinor: 20_000n,
    merchantIds: ["mrc_runfast"],
    expiresAt: new Date(Date.now() + 86_400_000),
  });
});

describe("fixAmber", () => {
  test("commits to the evidence's cart once, and every later attempt signs the same", async () => {
    const id = await purchase("COUNTERSIGNED", { cart, product, webFact: notarized() });
    const first = await fixAmber(testDb, id);
    expect(first).toMatchObject({
      url: VARIANT,
      sku: "RF-TMP3-11",
      size: "11",
      color: "blue",
      unit_minor: "12900",
      returns_free: true,
    });
    const url = new URL(VARIANT);
    const opened = await amberCommitment(
      amberProduct(url),
      { sku: "RF-TMP3-11", size: "11", color: "blue", unitMinor: 12_900n, returnsFree: true },
      BigInt(first?.salt as string),
    );
    expect(BigInt(first?.commitment as string)).toBe(opened);
    expect(BigInt(first?.salt as string) < 1n << 248n).toBe(true);
    expect(await fixAmber(testDb, id)).toEqual(first);
  });

  test("a coverage first sent without one stays without one", async () => {
    const id = await purchase("COUNTERSIGNED", { cart, product });
    expect(await fixAmber(testDb, id, false)).toBeNull();
    const [row] = await testDb.select().from(purchases).where(eq(purchases.id, id));
    expect(row?.amber).toBeNull();
  });

  test.each([
    ["no notarized answer", undefined],
    ["an answer of another size", notarized({ size: "10" })],
    ["an answer with another field", notarized({ stock: 3 })],
    ["an answer of another page", notarized({}, VARIANT.replace("RF-TMP3-11", "RF-TMP3-10"))],
    ["bytes that are not JSON", { url: VARIANT, committed: "7b" }],
  ])("evidence with %s leaves the coverage without one", async (_, webFact) => {
    const id = await purchase("COUNTERSIGNED", { cart, product, webFact });
    expect(await fixAmber(testDb, id)).toBeNull();
  });

  test("a cart it cannot attest leaves the coverage without one", async () => {
    const id = await purchase("COUNTERSIGNED", { cart: { ...cart, lines: [line, line] }, product });
    expect(await fixAmber(testDb, id)).toBeNull();
    const [row] = await testDb.select().from(purchases).where(eq(purchases.id, id));
    expect(row?.amber).toBeNull();
  });
});

const fact = {
  hostHash: keccak256(stringToHex("store.keelson.finance")),
  urlPathHash: keccak256(stringToHex("/api/products/tempo-3/variants/RF-TMP3-11")),
  tCapture: 1_794_300_000,
  rangeCommitment: `0x${createHash("sha256")
    .update(
      '{"sku":"RF-TMP3-11","size":"11","color":"blue","unit_minor":12900,"returns_free":true}',
    )
    .update(Buffer.from(Array.from({ length: 16 }, (_, i) => 0x10 + i)))
    .digest("hex")}` as Hex,
  attId: zeroHash,
};

/** A `slashAmber` call convicting `amber` of `fieldId`, with the vector's proof. */
function slashCall(coverageId: Hex, amber: Hex, fieldId: number, proof: Hex): Hex {
  return encodeFunctionData({
    abi: amberContradictionCourtAbi,
    functionName: "slashAmber",
    args: [
      {
        coverageId,
        agentId: 1n,
        merchant: "0x467D2beBb479D9B80Ab1c461243E05A2b82387d8",
        amount: 1n,
        premium: 0n,
        expiresAt: 0,
        mandateHash: zeroHash,
        amberCommitment: amber,
        userKeyHash: zeroHash,
      },
      {
        requestId: coverageId,
        mandateHash: zeroHash,
        mandateCommitment: zeroHash,
        cartHash: zeroHash,
        agentId: 1n,
        merchantId: zeroHash,
        amount: 0n,
        currency: 840,
        category: 0,
        evidenceRoot: zeroHash,
        evalHash: zeroHash,
        policySetHash: zeroHash,
        decision: 1,
        failedFieldsMask: 0,
        issuedAt: 0,
        expiresAt: 0,
      },
      "0x",
      fact,
      "0x",
      { document: "0x", salt: zeroHash, index: 0n, size: 1n, path: [], digestAt: 0n },
      fieldId,
      proof,
    ],
  });
}

describe("the court's events", () => {
  test("a coverage id names its purchase", () => {
    const id = ulid();
    expect(purchaseOfCoverage(ulidToBytes32(id) as Hex)).toBe(id);
    expect(purchaseOfCoverage(`0x${"ff".repeat(32)}`)).toBeNull();
  });

  test("a slashAmber call yields the proof and the statement the court verified", () => {
    const v = vector("color");
    const c2b = c2bOfCall(
      slashCall(ulidToBytes32(ulid()) as Hex, v.publicInputs[2] as Hex, 2, v.proof),
    );
    expect(c2b?.public_inputs).toEqual(v.publicInputs);
    expect(c2b?.bytes).toBe((v.proof.length - 2) / 2);
    expect(c2b?.hash).toBe(keccak256(v.proof));
    expect(c2b?.fact.t_capture).toBe(String(fact.tCapture));
  });

  test("the indexer's AmberContradictionProven events are projected once, then handled", async () => {
    const id = await purchase("SLASHED");
    const coverageId = ulidToBytes32(id) as Hex;
    const v = vector("size");
    const txHash = `0x${randomBytes(32).toString("hex")}` as Hex;
    const court = deploymentsFor(421614).AmberContradictionCourt as Hex;
    const [stored] = await ingest(
      testDb,
      [
        {
          address: court,
          blockHash: `0x${randomBytes(32).toString("hex")}`,
          blockNumber: 330_000_000n,
          data: "0x",
          logIndex: 3,
          transactionHash: txHash,
          transactionIndex: 0,
          removed: false,
          topics: [],
          eventName: "AmberContradictionProven",
          args: { coverageId, agentId: agentId, fieldId: 1, webFactDigest: `0x${"ab".repeat(32)}` },
        } as EventLog,
      ],
      { finalized: false },
    );
    expect(stored).toBeDefined();
    const reads: string[] = [];
    const client = {
      getTransaction: async () => {
        reads.push("tx");
        return { to: court, input: slashCall(coverageId, v.publicInputs[2] as Hex, 1, v.proof) };
      },
      getBlock: async () => {
        reads.push("block");
        return { timestamp: 1_794_400_000n };
      },
    } as unknown as PublicClient;
    const log = pino({ level: "silent" });

    expect(await projectAmberConvictions({ db: testDb, log, client })).toBe(1);
    const [row] = await testDb
      .select()
      .from(amberConvictions)
      .where(eq(amberConvictions.purchaseId, id));
    expect(row).toMatchObject({
      fieldId: 1,
      provenAt: new Date(1_794_400_000 * 1000),
      blockNumber: 330_000_000n,
    });
    expect(row?.proof?.public_inputs).toEqual(v.publicInputs);
    // Handled: the next pass reads nothing.
    expect(await projectAmberConvictions({ db: testDb, log, client })).toBe(0);
    expect(reads).toEqual(["tx", "block"]);
  });

  test("another call yields none", () => {
    expect(c2bOfCall("0xdeadbeef")).toBeNull();
  });
});

describe("amber in dispute data", () => {
  const app = createApp({ db: testDb, kv: testKv, log: pino({ level: "silent" }) });
  const disputeId = `PP-D-${randomBytes(4).toString("hex")}`;
  let convicted = "";
  let attestedOnly = "";
  const v = vector("color");

  beforeAll(async () => {
    convicted = await purchase("SLASHED", {
      // A red Tempo 3 attested, which the court convicted from the store's answer, blue.
      cart: { ...cart, lines: [{ ...line, color: "red" }] },
      product: { ...product, color: "red" },
      webFact: notarized({ color: "red" }),
    });
    await fixAmber(testDb, convicted);
    attestedOnly = await purchase("COVERED", { cart, product, webFact: notarized() });
    await fixAmber(testDb, attestedOnly);
    await purchase("COVERED");
    await testDb.insert(disputes).values({
      id: disputeId,
      purchaseId: convicted,
      reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      raw: {},
    });
    const coverageId = ulidToBytes32(convicted) as Hex;
    await testDb.insert(amberConvictions).values({
      coverageId: Buffer.from(coverageId.slice(2), "hex"),
      purchaseId: purchaseOfCoverage(coverageId),
      chainId: 421614,
      fieldId: 2,
      provenAt: new Date("2026-11-10T12:00:00Z"),
      webFactDigest: Buffer.alloc(32, 0xab),
      txHash: Buffer.alloc(32, 0xcd),
      blockNumber: 1n,
      proof: c2bOfCall(slashCall(coverageId, v.publicInputs[2] as Hex, 2, v.proof)),
    });
  });

  test("the public dispute shows the field proven false and the proof, not what was bought", async () => {
    const body = await (await app.request(`/v1/disputes/${disputeId}`)).json();
    expect(body.amber).toMatchObject({
      attested: null,
      conviction: {
        field: "color",
        attested_value: null,
        proven_at: "2026-11-10T12:00:00.000Z",
        web_fact_digest: `0x${"ab".repeat(32)}`,
        captured_at: new Date(fact.tCapture * 1000).toISOString(),
        tx_hash: `0x${"cd".repeat(32)}`,
        explorer_url: `https://sepolia.arbiscan.io/tx/0x${"cd".repeat(32)}`,
        proof: { bytes: (v.proof.length - 2) / 2, public_inputs: v.publicInputs },
      },
    });
    expect(JSON.stringify(body.amber)).not.toContain("RF-TMP3");
    expect(body.amber.commitment).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("the authenticated read keeps what the operator attested, never the salt", async () => {
    const cases = await amberCases(testDb, [convicted]);
    expect(cases.get(convicted)).toMatchObject({
      attested: { url: VARIANT, sku: "RF-TMP3-11", color: "red", returns_free: true },
      conviction: { field: "color", attested_value: "red" },
    });
    expect(cases.get(convicted)?.attested).not.toHaveProperty("salt");
    expect((await amberCases(testDb, [convicted], { redact: true })).get(convicted)).toMatchObject({
      attested: null,
      conviction: { attested_value: null },
    });
  });

  test("the operator's book filters and shows the amber state", async () => {
    const block = await coverageRows(testDb, agentId, {
      startRow: 0,
      endRow: 100,
      sortModel: [],
      filterModel: {},
    });
    const byId = new Map(block.rows.map((r) => [r.id, r]));
    expect(byId.get(convicted)).toMatchObject({
      amber: "contradicted",
      amberField: "color",
      amberClaimed: "red",
      amberProvenAt: "2026-11-10T12:00:00.000Z",
      amberWebFact: `0x${"ab".repeat(32)}`,
      amberTx: `https://sepolia.arbiscan.io/tx/0x${"cd".repeat(32)}`,
    });
    expect(byId.get(attestedOnly)).toMatchObject({ amber: "attested", amberField: null });
    const filtered = await coverageRows(testDb, agentId, {
      startRow: 0,
      endRow: 100,
      sortModel: [],
      filterModel: { amber: { filterType: "set", values: ["contradicted"] } },
    });
    // Other tests of this operator convict too: the filter keeps only convictions, this one among them.
    expect(filtered.rows.map((r) => r.id)).toContain(convicted);
    expect(filtered.rows.map((r) => r.id)).not.toContain(attestedOnly);
    expect(filtered.rows.every((r) => r.amber === "contradicted")).toBe(true);
  });
});
