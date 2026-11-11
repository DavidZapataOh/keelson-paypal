import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { decodeReceipt } from "../src/codec.ts";
import {
  type AnonymousPurchase,
  anonymousPurchaseFacts,
  anonymousPurchaseStatement,
  bindAnonymousPurchase,
  c1c3Statement,
  readAnonymousPurchase,
  verifyC1C3,
} from "../src/verify/index.ts";
import { copy, fixtures } from "./fixtures.ts";

/** A sandbox purchase whose C1 and C3 proofs were composed, as the public API serves them. */
const ID = "01M73AGWP5EJSW35XE6Q090MCH";
const dir = new URL("./fixtures/", import.meta.url);
const receipt = decodeReceipt(readFileSync(new URL(`${ID}.receipt`, dir)));
const proof = JSON.parse(
  readFileSync(new URL(`${ID}.anonymous.json`, dir), "utf8"),
) as AnonymousPurchase;
const word = (n: bigint): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;

describe("anonymousPurchaseStatement", () => {
  test("a receipt fixes C_m, the time, the cart, the operator and M, and nothing else", () => {
    const s = anonymousPurchaseStatement(receipt);
    expect(s).toHaveLength(10);
    for (const i of [0, 5, 6, 7, 8]) expect(s[i]).toBe(proof.public_inputs[i]);
    for (const i of [1, 2, 3, 4, 9]) expect(s[i]).toBeUndefined();
  });

  test("a bundle fixes every input but the root, as C1C3's statement of its countersign", () => {
    const b = (fixtures[0] as (typeof fixtures)[number]).bundle;
    const root = word(7n);
    expect(anonymousPurchaseStatement(b)).toEqual([
      ...c1c3Statement(b.tee.countersign, root).slice(0, 9),
      undefined,
    ]);
  });
});

describe("bindAnonymousPurchase", () => {
  test("the composed proof is of the purchase the receipt logs", () => {
    expect(bindAnonymousPurchase(receipt, proof.public_inputs)).toEqual({
      bound: [0, 5, 6, 7, 8],
      mismatched: [],
    });
  });

  test("names each input of another purchase", () => {
    const other = [...proof.public_inputs];
    other[0] = word(1n);
    other[6] = word(2n);
    expect(bindAnonymousPurchase(receipt, other).mismatched).toEqual([0, 6]);
    expect(bindAnonymousPurchase(receipt, proof.public_inputs.slice(0, 9)).mismatched).toEqual([9]);
  });

  test("an edited bundle no longer binds a proof of the original", () => {
    const b = copy((fixtures[0] as (typeof fixtures)[number]).bundle);
    const original = [...c1c3Statement(b.tee.countersign, word(7n))];
    b.tee.countersign.amount = "1";
    expect(bindAnonymousPurchase(b, original).mismatched).toEqual([1]);
  });
});

describe("anonymousPurchaseFacts", () => {
  test("reads what the proof states in product terms", () => {
    expect(anonymousPurchaseFacts(proof.public_inputs)).toEqual({
      amount: { currency: "USD", minor: 100n },
      category: "gpt:187",
      merchantId: proof.public_inputs[4],
      at: new Date("2026-11-10T18:11:32Z"),
      operatorId: "351",
      userSetRoot: proof.user_set_root,
    });
  });
});

describe("verifyC1C3", () => {
  test("accepts the production proof and refuses it for any other statement", async () => {
    expect(await verifyC1C3(proof.proof, proof.public_inputs)).toBe(true);
    const other = [...proof.public_inputs];
    other[1] = word(101n);
    expect(await verifyC1C3(proof.proof, other)).toBe(false);
  });
});

describe.skipIf(process.env.KEELSON_LIVE !== "1")("on Arbitrum Sepolia", () => {
  const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;
  const opts = rpc ? { rpc: { 421614: [rpc, "https://sepolia-rollup.arbitrum.io/rpc"] } } : {};

  test("the deployed verifier accepts the proof and the registry holds its root", async () => {
    let requests = 0;
    const answer = await readAnonymousPurchase(421614, proof, {
      ...opts,
      fetchFn: (input, init) => {
        requests++;
        return fetch(input, init);
      },
    });
    expect(requests).toBe(1);
    expect(answer.accepted).toBe(true);
    expect(answer.root.publishedAt).toBe(1794334197);
    expect(answer.root.size).toBe(125);
    expect(answer.root.revokedAt).toBe(0);
    expect(answer.root.log).toEqual({ size: 125, blockNumber: 327946605n });
  });

  test("the verifier refuses the proof of another statement", async () => {
    const other = [...proof.public_inputs];
    other[1] = word(101n);
    const answer = await readAnonymousPurchase(421614, { ...proof, public_inputs: other }, opts);
    expect(answer.accepted).toBe(false);
  });
});
