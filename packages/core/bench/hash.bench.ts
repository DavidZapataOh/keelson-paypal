import { test } from "vitest";
import { DST, hashObject } from "../src/hash.js";
import { type Json, jcs } from "../src/jcs.js";
import { poseidon2 } from "../src/poseidon2.js";
import fixture from "../test/fixtures/alibi-4kb.json" with { type: "json" };

const alibi = fixture as Json;
const inputs = Array.from({ length: 10 }, (_, i) => BigInt(i + 1) * 0x1234567890abcdefn);

test("jcs, 4 KB alibi", async ({ bench }) => {
  await bench("jcs", () => {
    jcs(alibi);
  }).run();
});

test("hashObject, 4 KB alibi", async ({ bench }) => {
  await bench("hashObject", () => {
    hashObject(DST.alibi, alibi);
  }).run();
});

test("poseidon2, 10 inputs", async ({ bench }) => {
  await bench("poseidon2", async () => {
    await poseidon2(inputs);
  }).run();
});
