import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
  type PublicClient,
  zeroAddress,
} from "viem";
import { identityRegistryAbi } from "./abis.ts";
import { ERC8004, type Erc8004ChainId } from "./addresses.ts";

/** The EIP-712 type an agent's owner or agent wallet signs to bind a Keelson `cnf` key to it. */
export const OPERATOR_LINK_TYPES = {
  OperatorLink: [
    { name: "agentId", type: "uint256" },
    { name: "cnfThumbprint", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function operatorLinkDomain(chainId: Erc8004ChainId): {
  name: "Keelson";
  version: "1";
  chainId: Erc8004ChainId;
} {
  return { name: "Keelson", version: "1", chainId };
}

export type OperatorLinkResult =
  | { ok: true; signer: Address; owner: Address }
  | { ok: false; reason: "expired" | "not-owner" | "no-agent" };

/**
 * Checks that `signature` is an `OperatorLink` signed by the agent's current owner or its
 * `agentWallet`, as an EOA, ERC-1271 or ERC-6492 signature. `deadline` is in Unix seconds.
 */
export async function verifyOperatorLink(
  client: Pick<PublicClient, "readContract" | "verifyTypedData">,
  chainId: Erc8004ChainId,
  agentId: bigint,
  cnfThumbprint: Hex,
  deadline: bigint,
  signature: Hex,
  now: Date = new Date(),
): Promise<OperatorLinkResult> {
  if (deadline <= BigInt(Math.floor(now.getTime() / 1000))) return { ok: false, reason: "expired" };
  const identity = { address: ERC8004[chainId].identity, abi: identityRegistryAbi } as const;
  const [owner, wallet] = await Promise.all([
    client
      .readContract({ ...identity, functionName: "ownerOf", args: [agentId] })
      .catch((err: unknown) => {
        if (
          err instanceof BaseError &&
          err.walk((e) => e instanceof ContractFunctionRevertedError)
        ) {
          return undefined;
        }
        throw err;
      }),
    client.readContract({ ...identity, functionName: "getAgentWallet", args: [agentId] }),
  ]);
  if (owner === undefined) return { ok: false, reason: "no-agent" };
  const typed = {
    domain: operatorLinkDomain(chainId),
    types: OPERATOR_LINK_TYPES,
    primaryType: "OperatorLink",
    message: { agentId, cnfThumbprint, deadline },
    signature,
  } as const;
  for (const signer of wallet === zeroAddress || wallet === owner ? [owner] : [owner, wallet]) {
    if (await client.verifyTypedData({ ...typed, address: signer })) {
      return { ok: true, signer, owner };
    }
  }
  return { ok: false, reason: "not-owner" };
}
