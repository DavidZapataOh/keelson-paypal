import { readFileSync } from "node:fs";
import { BN254_FR_MODULUS, poseidon2 } from "@keelson/core/poseidon2";
import { describe, expect, it } from "vitest";
import { C3_MAX_CLIENT_DATA, c3Inputs, USER_SET_DEPTH, userPath, userSet } from "../src/c3.ts";
import { type Mandate, parseMandate } from "../src/schema.ts";
import vector from "./vectors/c3.json" with { type: "json" };

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const mandate = (): Mandate => parseMandate(structuredClone(vector.mandate));
const salt = new Uint8Array(Buffer.from(vector.salt, "base64url"));
const leaves = vector.users.map(BigInt);

async function rootOf(leaf: bigint, index: number, path: bigint[]): Promise<bigint> {
  let node = leaf;
  for (let h = 0; h < USER_SET_DEPTH; h++) {
    const sibling = path[h] as bigint;
    node = await poseidon2((index >> h) & 1 ? [sibling, node] : [node, sibling]);
  }
  return node;
}

describe("userSet", () => {
  it("opens every leaf to the root", async () => {
    const set = await userSet([1n, 2n, 3n, 4n, 5n]);
    for (const [i, leaf] of set.leaves.entries()) {
      expect(await rootOf(leaf, i, await userPath(set, i))).toBe(set.root);
    }
  });

  it("an empty set has the root of empty subtrees", async () => {
    const empty = await userSet([]);
    let z = 0n;
    for (let h = 0; h < USER_SET_DEPTH; h++) z = await poseidon2([z, z]);
    expect(empty.root).toBe(z);
  });

  it("a new user changes the root", async () => {
    expect((await userSet([1n, 2n])).root).not.toBe((await userSet([1n, 2n, 3n])).root);
  });

  it("has no path past the last user", async () => {
    const set = await userSet([1n]);
    await expect(userPath(set, 1)).rejects.toThrow(RangeError);
    await expect(userPath(set, -1)).rejects.toThrow(RangeError);
  });
});

describe("c3Inputs", () => {
  const args = async (capture: "payment" | "webauthn") => ({
    mandate: mandate(),
    salt,
    payloadSd: vector.payloadSd,
    assertion: vector[capture].assertion,
    users: await userSet(leaves),
  });

  for (const capture of ["payment", "webauthn"] as const) {
    it(`builds the ${capture} statement and the circuit's inputs`, async () => {
      const { inputs, statement } = await c3Inputs(await args(capture));
      expect(
        Object.fromEntries(Object.entries(statement).map(([k, x]) => [k, `0x${x.toString(16)}`])),
      ).toEqual(vector[capture].statement);
      const toml = readFileSync(
        new URL(`../../../circuits/c3/Prover_${capture}.toml`, import.meta.url),
        "utf8",
      );
      expect(toml).toContain(`c_m = "${inputs.c_m}"`);
      expect(toml).toContain(`user_index = "${inputs.user_index}"`);
    });
  }

  it("names the RP ID hash of keelson.finance and a field mandate hash", async () => {
    const { statement } = await c3Inputs(await args("payment"));
    expect(statement.rpIdHash).toBe(
      0x1071caa839ec25d37b233c1d4b37fd3a9d1b0a09830e137e452105c07d6fc4f7n,
    );
    expect(statement.mandateHash < BN254_FR_MODULUS).toBe(true);
  });

  it("takes the low-s form of a high-s signature", async () => {
    const a = await args("payment");
    const der = Buffer.from(a.assertion.signature, "base64url");
    const rLen = der[3] as number;
    const s = BigInt(`0x${der.subarray(6 + rLen).toString("hex")}`);
    const { inputs } = await c3Inputs(a);
    const sig = (inputs.assertion as { signature: number[] }).signature;
    const low = BigInt(`0x${Buffer.from(sig.slice(32)).toString("hex")}`);
    expect(low).toBe(s > P256_N / 2n ? P256_N - s : s);
    expect(low <= P256_N / 2n).toBe(true);
  });

  it("refuses a passkey that is not a registered user", async () => {
    const a = await args("payment");
    await expect(c3Inputs({ ...a, users: await userSet(leaves.slice(0, 1)) })).rejects.toThrow(
      "not a registered user",
    );
  });

  it("refuses an assertion over another mandate", async () => {
    const a = await args("payment");
    await expect(c3Inputs({ ...a, payloadSd: { ...vector.payloadSd, iat: 0 } })).rejects.toThrow(
      "not over this mandate's challenge",
    );
    await expect(c3Inputs({ ...a, salt: new Uint8Array(16) })).rejects.toThrow(
      "not over this mandate's challenge",
    );
  });

  it("refuses client data longer than the circuit takes", async () => {
    const a = await args("webauthn");
    const json = JSON.parse(Buffer.from(a.assertion.clientDataJSON, "base64url").toString());
    const long = JSON.stringify({ ...json, pad: "x".repeat(C3_MAX_CLIENT_DATA) });
    await expect(
      c3Inputs({
        ...a,
        assertion: { ...a.assertion, clientDataJSON: Buffer.from(long).toString("base64url") },
      }),
    ).rejects.toThrow("too long");
  });

  it("refuses a malformed signature", async () => {
    const a = await args("payment");
    await expect(
      c3Inputs({ ...a, assertion: { ...a.assertion, signature: "MAAA" } }),
    ).rejects.toThrow("malformed DER signature");
  });
});
