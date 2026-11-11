import { readFileSync } from "node:fs";
import { getAddress } from "viem";
import { expect, test } from "vitest";
import { EXTERNAL, isAllowed } from "../src/allowlist.ts";

const registry = (chainId: number) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../contracts/deployments/${chainId}.json`, import.meta.url),
      "utf8",
    ),
  ) as { external: { pyusd: string; erc8004Reputation: string } };

test.each([421614, 42161] as const)(
  "chain %i's external contracts match the deployment registry",
  (chainId) => {
    const { external } = registry(chainId);
    expect(EXTERNAL[chainId]).toEqual({
      PYUSD: getAddress(external.pyusd),
      ReputationRegistry: getAddress(external.erc8004Reputation),
    });
  },
);

test("of PYUSD and the Reputation registry only the signed transfer and feedback are relayable", () => {
  expect(isAllowed("PYUSD", "transferWithAuthorization")).toBe(true);
  expect(isAllowed("ReputationRegistry", "giveFeedback")).toBe(true);
  for (const fn of ["transfer", "transferFrom", "approve", "receiveWithAuthorization", "permit"]) {
    expect(isAllowed("PYUSD", fn)).toBe(false);
  }
  for (const fn of ["revokeFeedback", "appendResponse"]) {
    expect(isAllowed("ReputationRegistry", fn)).toBe(false);
  }
});

test("of RegisteredUserSet only publishing a root is relayable, never revoking one", () => {
  expect(isAllowed("RegisteredUserSet", "publish")).toBe(true);
  expect(isAllowed("RegisteredUserSet", "revoke")).toBe(false);
});

test("of EngineProofVerifier only recording a proof is relayable", () => {
  expect(isAllowed("EngineProofVerifier", "record")).toBe(true);
  expect(isAllowed("EngineProofVerifier", "verify")).toBe(false);
});
