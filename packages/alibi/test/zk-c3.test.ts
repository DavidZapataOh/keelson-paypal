import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { toBase64 } from "../src/b64.ts";
import { verifyAlibi } from "../src/verify/index.ts";
import { OFFLINE } from "../src/verify/report.ts";
import { c3Statement, RP_ID_HASH, verifyAnonymousMandate, verifyC3 } from "../src/verify/zk.ts";

/** Proofs of the demo mandate's C3 statement, as `circuits/c3/prove.sh` writes them. */
const read = (type: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../contracts/test/vectors/c3-${type}.json`, import.meta.url),
      "utf8",
    ),
  ) as { proof: `0x${string}`; publicInputs: `0x${string}`[] };
const statement = JSON.parse(
  readFileSync(new URL("../../mandate/test/vectors/c3.json", import.meta.url), "utf8"),
) as { payment: { statement: Record<string, string> } };

import { copy, fixtures } from "./fixtures.ts";

const b64 = (hex: string) => toBase64(Buffer.from(hex.slice(2), "hex"));
const word = (n: bigint): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = () => {
    throw new Error("verification must not use the network");
  };
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("verifyC3", () => {
  for (const type of ["payment", "webauthn"]) {
    test(`accepts the ${type} proof and nothing else`, async () => {
      const v = read(type);
      expect(await verifyC3(b64(v.proof), v.publicInputs)).toBe(true);
      for (let i = 0; i < v.publicInputs.length; i++) {
        const other = [...v.publicInputs];
        other[i] = word(BigInt(other[i] as string) + 1n);
        expect(await verifyC3(b64(v.proof), other)).toBe(false);
      }
      const bytes = Buffer.from(v.proof.slice(2), "hex");
      bytes[100] = (bytes[100] as number) ^ 1;
      expect(await verifyC3(bytes.toString("base64"), v.publicInputs)).toBe(false);
      expect(await verifyC3("", v.publicInputs)).toBe(false);
    });
  }
});

describe("c3Statement", () => {
  test("is the mandate's commitment, hash, the tree root and Keelson's RP ID hash", () => {
    const s = statement.payment.statement;
    const v = read("payment");
    expect(
      c3Statement({
        mandateCommitment: s.cm as string,
        mandateHash: s.mandateHash as string,
        userSetRoot: s.userSetRoot as string,
      }),
    ).toEqual(v.publicInputs);
    expect(v.publicInputs[3]).toBe(RP_ID_HASH);
  });
});

describe("verifyAnonymousMandate", () => {
  const v = read("payment");
  const s = statement.payment.statement;
  const c3 = {
    user_set_root: v.publicInputs[2] as string,
    proof: b64(v.proof),
    public_inputs: v.publicInputs,
  };
  const mandate = { mandateCommitment: s.cm as string, mandateHash: s.mandateHash as string };
  const registered = async (root: string) => root === c3.user_set_root;

  test("accepts a registered user's proof of this mandate", async () => {
    expect(await verifyAnonymousMandate(c3, mandate, registered)).toBe(true);
  });

  test("refuses an unregistered root, another mandate or another RP", async () => {
    expect(await verifyAnonymousMandate(c3, mandate, async () => false)).toBe(false);
    const other = { ...mandate, mandateHash: word(BigInt(mandate.mandateHash) + 1n) };
    expect(await verifyAnonymousMandate(c3, other, registered)).toBe(false);
    const rp = [...c3.public_inputs];
    rp[3] = word(1n);
    expect(await verifyAnonymousMandate({ ...c3, public_inputs: rp }, mandate, registered)).toBe(
      false,
    );
  });
});

describe("zk.c3", () => {
  const f = fixtures[0];
  if (!f) throw new Error("no fixture");
  const v = read("payment");
  const s = statement.payment.statement;
  const rootTx = `0x${"ab".repeat(32)}`;
  /** The fixture with the demo mandate's commitment and hash in place of its own. */
  const bundle = (proof = b64(v.proof)) => {
    const b = copy(f.bundle);
    b.tee.countersign.mandateCommitment = s.cm as string;
    b.tee.countersign.mandateHash = s.mandateHash as string;
    b.zk = { c3: { proof, public_inputs: v.publicInputs, root_tx: rootTx } };
    return b;
  };
  const check = async (b: ReturnType<typeof bundle>) =>
    (await verifyAlibi(b)).checks.find((c) => c.id === "zk.c3");

  test("checks the proof offline and leaves the root to the chain", async () => {
    const c = await check(bundle());
    expect(c?.status, JSON.stringify(c)).toBe("pending");
    expect(c?.reason).toBe(OFFLINE);
    expect(c?.detail).toMatchObject({
      verifier: "bb.js",
      user_set_root: v.publicInputs[2],
      root_tx: rootTx,
      chain_id: String(f.bundle.tee.domain.chain_id),
    });
  });

  test("fails a proof of another mandate", async () => {
    const b = bundle();
    b.tee.countersign.mandateHash = word(BigInt(s.mandateHash as string) + 1n);
    const c = await check(b);
    expect(c?.status).toBe("fail");
    expect(c?.reason).toBe("the proof is of another mandate or RP");
  });

  test("fails a proof that does not verify", async () => {
    const bytes = Buffer.from(v.proof.slice(2), "hex");
    bytes[64] = (bytes[64] as number) ^ 1;
    const c = await check(bundle(bytes.toString("base64")));
    expect(c?.status).toBe("fail");
    expect(c?.reason).toBe("the proof does not verify");
  });
});
