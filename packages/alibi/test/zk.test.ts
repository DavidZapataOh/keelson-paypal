import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { toBase64 } from "../src/b64.ts";
import type { AlibiBundle } from "../src/schema.ts";
import { verifyAlibi } from "../src/verify/index.ts";
import { c1Statement, verifyC1 } from "../src/verify/zk.ts";
import { copy, fixtures } from "./fixtures.ts";

/** A proof of the demo mandate's statement, as `circuits/c1/prove.sh` writes it. */
const vector = JSON.parse(
  readFileSync(new URL("../../../contracts/test/vectors/c1-proof.json", import.meta.url), "utf8"),
) as { proof: `0x${string}`; publicInputs: `0x${string}`[] };
const proof = toBase64(Buffer.from(vector.proof.slice(2), "hex"));
const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const word = (n: bigint): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;

/** The countersign fields the demo statement is of. */
function demoCountersign(base: AlibiBundle["tee"]["countersign"]) {
  const [cm, amount, currency, category, merchant, now, cart, operator] = vector.publicInputs;
  return {
    ...base,
    mandateCommitment: cm as string,
    amount: BigInt(amount as string).toString(),
    currency: BigInt(currency as string).toString(),
    category: BigInt(category as string).toString(),
    merchantId: merchant as string,
    issuedAt: BigInt(now as string).toString(),
    cartHash: cart as string,
    agentId: BigInt(operator as string).toString(),
  };
}

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = () => {
    throw new Error("verification must not use the network");
  };
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("verifyC1", () => {
  test("accepts the demo proof and nothing else", async () => {
    expect(await verifyC1(proof, vector.publicInputs)).toBe(true);
    const other = [...vector.publicInputs];
    other[1] = word(8501n);
    expect(await verifyC1(proof, other)).toBe(false);
    const bytes = Buffer.from(vector.proof.slice(2), "hex");
    bytes[100] = (bytes[100] as number) ^ 1;
    expect(await verifyC1(bytes.toString("base64"), vector.publicInputs)).toBe(false);
    expect(await verifyC1("", vector.publicInputs)).toBe(false);
  });
});

describe("c1Statement", () => {
  const base = fixtures[0]?.bundle.tee.countersign as AlibiBundle["tee"]["countersign"];

  test("is the countersign's fields in the circuit's order", () => {
    expect(c1Statement(demoCountersign(base))).toEqual(vector.publicInputs);
  });

  test("reduces a cart hash above the field modulus", () => {
    const cartHash = `0x${"f".repeat(64)}`;
    const s = c1Statement({ ...base, cartHash });
    expect(s[6]).toBe(word(BigInt(cartHash) % R));
    expect(BigInt(s[6] as string)).toBeLessThan(R);
  });
});

describe("zk.c1", () => {
  const f = fixtures[0];
  if (!f) throw new Error("no fixture");

  test("passes a proof of the countersign it carries", async () => {
    const b = copy(f.bundle);
    b.tee.countersign = demoCountersign(b.tee.countersign);
    b.zk = { c1: { proof, public_inputs: vector.publicInputs } };
    const report = await verifyAlibi(b);
    const c = report.checks.find((x) => x.id === "zk.c1");
    expect(c?.status, JSON.stringify(c)).toBe("pass");
    expect(c?.detail).toEqual({ verifier: "bb.js" });
  });

  test("fails a proof of another countersign", async () => {
    const b = copy(f.bundle);
    b.zk = { c1: { proof, public_inputs: vector.publicInputs } };
    const c = (await verifyAlibi(b)).checks.find((x) => x.id === "zk.c1");
    expect(c?.status).toBe("fail");
    expect(c?.reason).toBe("the proof is of another countersign");
  });

  test("fails a proof that does not verify", async () => {
    const b = copy(f.bundle);
    b.tee.countersign = demoCountersign(b.tee.countersign);
    const bytes = Buffer.from(vector.proof.slice(2), "hex");
    bytes[64] = (bytes[64] as number) ^ 1;
    b.zk = { c1: { proof: bytes.toString("base64"), public_inputs: vector.publicInputs } };
    const c = (await verifyAlibi(b)).checks.find((x) => x.id === "zk.c1");
    expect(c?.status).toBe("fail");
    expect(c?.reason).toBe("the proof does not verify");
  });
});
