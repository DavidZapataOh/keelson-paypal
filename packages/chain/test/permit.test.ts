import { hashDomain } from "viem";
import { expect, test } from "vitest";
import { addresses, bondPermitTypedData } from "../src/index.ts";

test("the permit's domain is PYUSD's DOMAIN_SEPARATOR on Arbitrum Sepolia, and its spender the vault", () => {
  const typed = bondPermitTypedData({
    owner: "0xcdA4d2330C027Aa025f4A14b525a386CE02AD98f",
    value: 1n,
    nonce: 0n,
    deadline: 1n,
  });
  expect(
    hashDomain({
      domain: typed.domain,
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
      },
    }),
  ).toBe("0xf3ecc5aec9b5298246e45dbdcf197d113d30718459718fca6a79848cbabfacb2");
  expect(typed.message.spender).toBe(addresses[421614].KeelsonBondVault);
});
