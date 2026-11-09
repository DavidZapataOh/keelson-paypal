import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { LOG_ORIGINS, LOG_VKEYS, LOG_WITNESSES, parseWitnessPolicy } from "../src/index.ts";

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
});
