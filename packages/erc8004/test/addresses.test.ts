import { readFileSync } from "node:fs";
import { getAddress } from "viem";
import { expect, test } from "vitest";
import { agentRegistry, ERC8004, erc8004ChainIds, isErc8004ChainId } from "../src/index.ts";

const registry = (chainId: number) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../contracts/deployments/${chainId}.json`, import.meta.url),
      "utf8",
    ),
  ) as { external: { erc8004Identity: string; erc8004Reputation: string } };

test.each(erc8004ChainIds)("chain %i matches the deployment registry", (chainId) => {
  const { external } = registry(chainId);
  expect(ERC8004[chainId]).toEqual({
    identity: getAddress(external.erc8004Identity),
    reputation: getAddress(external.erc8004Reputation),
  });
  expect(agentRegistry(chainId)).toBe(`eip155:${chainId}:${getAddress(external.erc8004Identity)}`);
});

test("only the three chains are ERC-8004 chains", () => {
  expect(erc8004ChainIds.every(isErc8004ChainId)).toBe(true);
  expect(isErc8004ChainId(1)).toBe(false);
  expect(isErc8004ChainId(84532)).toBe(false);
});
