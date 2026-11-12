import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  CUTOVER_PENDING,
  LOG_ORIGINS,
  LOG_VKEY_HISTORY,
  LOG_VKEYS,
  LOG_WITNESSES,
  parseWitnessPolicy,
  receiptKeyMap,
} from "../src/index.ts";

const read = (name: string) =>
  readFileSync(new URL(`../../../services/log/${name}`, import.meta.url), "utf8");

test("the verifier keys are the log's committed keys", () => {
  expect(LOG_VKEYS[LOG_ORIGINS[421614] as string]).toEqual([
    read("keys/alibi-2026-1.vkey").trim(),
    read("keys/alibi-2026-1.mldsa.vkey").trim(),
  ]);
  expect(LOG_VKEYS[LOG_ORIGINS[42161] as string]).toEqual([
    read("keys/alibi-live-2026-1.vkey").trim(),
    read("keys/alibi-live-2026-1.mldsa.vkey").trim(),
  ]);
});

test.each([
  [421614, "alibi-2026-1"],
  [42161, "alibi-live-2026-1"],
])("the witnesses of chain %i are its log's policy", (chainId, file) => {
  const origin = LOG_ORIGINS[chainId] as string;
  const policy = parseWitnessPolicy(read(`policy/${file}.policy`));
  expect(policy.logs).toEqual(LOG_VKEYS[origin]);
  expect(policy.quorum).toEqual({ group: "own", k: 2, members: ["w1", "w2", "w3"] });
  expect({
    vkeys: policy.quorum.members.map((m) => policy.witnesses.get(m)),
    quorum: policy.quorum.k,
  }).toEqual(LOG_WITNESSES[origin]);
});

test("the conformance and sigsum policies parse", () => {
  const conformance = parseWitnessPolicy(read("policy/conformance-2026-1.policy"));
  expect(conformance.logs).toEqual([read("keys/conformance-2026-1.vkey").trim()]);
  expect(conformance.quorum.k).toBe(2);
  const sigsum = parseWitnessPolicy(read("policy/sigsum-seasalp.policy"));
  expect(sigsum.quorum).toMatchObject({ group: "quorum-rule", k: 2 });
  expect(sigsum.witnesses.size).toBe(3);
});

test("malformed policies are refused", () => {
  expect(() => parseWitnessPolicy("witness w1 k\ngroup g 2 w1\nquorum g")).toThrow("threshold");
  expect(() => parseWitnessPolicy("witness w1 k\ngroup g 1 w2\nquorum g")).toThrow("not a witness");
  expect(() => parseWitnessPolicy("witness w1 k")).toThrow("no quorum");
  expect(() => parseWitnessPolicy("quorum g")).toThrow("unknown group");
  expect(parseWitnessPolicy("quorum none").quorum.k).toBe(0);
  expect(() => parseWitnessPolicy("witness w1 k\nwitness w2 k\ngroup g 2 w1 w2\nquorum g")).toThrow(
    "repeats",
  );
  expect(() => parseWitnessPolicy("witness w1 k\ngroup none 1 w1\nquorum none")).toThrow(
    "reserved",
  );
});

test("the Ed25519 keys are the ones leg A derives under its on-chain KMS app", () => {
  const derived = JSON.parse(
    readFileSync(
      new URL("../../../engine/tee/tests/fixtures/onchain-kms/getkey-chain.json", import.meta.url),
      "utf8",
    ),
  ) as { origin: string; vkey: string }[];
  for (const { origin, vkey } of derived) expect(LOG_VKEYS[origin]?.[0]).toBe(vkey);
});

// The cutover size is the size the log anchored when the new key signed its first checkpoint.
test("no retired key set still waits for its cutover size", () => {
  const pending = Object.entries(LOG_VKEY_HISTORY).flatMap(([origin, sets]) =>
    sets.filter((s) => s.untilSize === CUTOVER_PENDING).map(() => origin),
  );
  expect(pending).toEqual([]);
});

test("the pinned receipt keys are the ones leg A signs receipts with", () => {
  expect([...receiptKeyMap().keys()].sort()).toEqual([
    // receipt_kid of each origin in leg A's /v1/health: the SHA-256 of its receipt key.
    "1b9e874e85938d350bfb77e541bb2b465255dc1478b31325332cf9f52553c80d",
    "3470cd852e6d2195ccf31d99622472cfea51d989687609f5170d681715a4395c",
  ]);
});
