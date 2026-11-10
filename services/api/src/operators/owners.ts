import { type Db, eq, operators, walletAddress } from "@keelson/db";
import { ERC8004, identityRegistryAbi } from "@keelson/erc8004";
import { type Address, getAddress } from "viem";
import type { ChainReaders } from "../chain/reader.ts";
import { DEMO_OPERATOR } from "../routes/operators.ts";

/** The chain the console's operators live on: the demo registry is on Arbitrum Sepolia. */
export const OPERATOR_CHAIN = 421614 as const;
/** How long an agent's owner and agent wallet are reused before they are read again. */
const AUTHORITY_MS = 60_000;

/**
 * Whether `address` owned a linked operator when it was linked, or owns the demo operator: the
 * wallets that may open an operator session. Each operator route checks ownership on chain again.
 */
export async function ownsLinkedOperator(db: Db, address: string): Promise<boolean> {
  const owner = getAddress(address);
  if (owner === DEMO_OPERATOR.owner) return true;
  const [row] = await db
    .select({ agentId: operators.agentId })
    .from(operators)
    .where(eq(operators.ownerAddress, Buffer.from(owner.slice(2), "hex")))
    .limit(1);
  return row !== undefined;
}

/** The wallets a user signed in with (EIP-4361), checksummed. */
export async function walletsOf(db: Db, userId: string): Promise<Address[]> {
  const rows = await db
    .select({ address: walletAddress.address })
    .from(walletAddress)
    .where(eq(walletAddress.userId, userId));
  return rows.map((r) => getAddress(r.address));
}

/**
 * Reads who may act for an agent: its owner and its agent wallet in the Identity registry, cached
 * for a minute. `undefined` when the agent is not minted.
 */
export function agentAuthority(chains: ChainReaders | undefined) {
  const cache = new Map<bigint, { at: number; value: Promise<Address[] | undefined> }>();
  return (agentId: bigint): Promise<Address[] | undefined> => {
    const hit = cache.get(agentId);
    if (hit && Date.now() - hit.at < AUTHORITY_MS) return hit.value;
    const reader = chains?.[OPERATOR_CHAIN];
    if (!reader) return Promise.reject(new Error(`chain ${OPERATOR_CHAIN} is not read`));
    const identity = { address: ERC8004[OPERATOR_CHAIN].identity, abi: identityRegistryAbi };
    const value = reader.client
      .multicall({
        allowFailure: true,
        contracts: [
          { ...identity, functionName: "ownerOf", args: [agentId] },
          { ...identity, functionName: "getAgentWallet", args: [agentId] },
        ],
      })
      .then(([owner, wallet]) => {
        if (owner.status !== "success") return undefined;
        const out = [getAddress(owner.result as Address)];
        if (wallet.status === "success" && /^0x0{40}$/i.test(wallet.result as string) === false) {
          out.push(getAddress(wallet.result as Address));
        }
        return out;
      });
    value.catch(() => cache.delete(agentId));
    cache.set(agentId, { at: Date.now(), value });
    if (cache.size > 1_024) cache.delete(cache.keys().next().value as bigint);
    return value;
  };
}
