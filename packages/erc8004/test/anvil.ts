import { type ChildProcess, spawn } from "node:child_process";
import {
  type Address,
  createPublicClient,
  createTestClient,
  type Hex,
  http,
  type PublicClient,
  parseEther,
  publicActions,
  walletActions,
} from "viem";
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { identityRegistryAbi } from "../src/abis.ts";
import { ERC8004 } from "../src/addresses.ts";

export const FORK_BLOCK = 327_277_000n;
const identity = { address: ERC8004[421614].identity, abi: identityRegistryAbi } as const;

export interface Fork {
  /** Reads the fork. */
  client: PublicClient;
  url: string;
  stop(): void;
  /** A fresh account holding 1 ETH on the fork. */
  account(): Promise<PrivateKeyAccount>;
  /** Mints a new agent to `owner` in the official Identity registry. */
  register(owner: PrivateKeyAccount): Promise<bigint>;
  /** Sets `wallet` as the agent's `agentWallet`, signed by `wallet` as the registry requires. */
  setAgentWallet(
    owner: PrivateKeyAccount,
    agentId: bigint,
    wallet: PrivateKeyAccount,
  ): Promise<void>;
  transfer(owner: PrivateKeyAccount, agentId: bigint, to: Address): Promise<void>;
  /** Unix seconds of the fork's latest block. */
  now(): Promise<bigint>;
}

/** An anvil fork of Arbitrum Sepolia at `FORK_BLOCK`, with the official ERC-8004 registries. */
export async function startFork(port: number): Promise<Fork> {
  const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;
  if (!rpc) throw new Error("ARBITRUM_SEPOLIA_RPC_URL is not set");
  const anvil: ChildProcess = spawn("anvil", [
    "--fork-url",
    rpc,
    "--fork-block-number",
    FORK_BLOCK.toString(),
    "--port",
    String(port),
    "--silent",
  ]);
  const url = `http://127.0.0.1:${port}`;
  const client = createTestClient({ chain: arbitrumSepolia, mode: "anvil", transport: http(url) })
    .extend(publicActions)
    .extend(walletActions);
  for (let i = 0; ; i++) {
    try {
      await client.getChainId();
      break;
    } catch (e) {
      if (i > 100) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const mined = async (hash: Hex) => {
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  };
  const now = async () => (await client.getBlock()).timestamp;
  return {
    client: createPublicClient({ chain: arbitrumSepolia, transport: http(url) }),
    url,
    stop: () => anvil.kill(),
    now,
    account: async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      await client.setBalance({ address: account.address, value: parseEther("1") });
      return account;
    },
    register: async (owner) => {
      const { request, result } = await client.simulateContract({
        ...identity,
        account: owner,
        functionName: "register",
        args: [],
      });
      await mined(await client.writeContract(request));
      return result;
    },
    setAgentWallet: async (owner, agentId, wallet) => {
      const [, name, version, chainId, verifyingContract] = await client.readContract({
        ...identity,
        functionName: "eip712Domain",
      });
      const deadline = (await now()) + 60n;
      const signature = await wallet.signTypedData({
        domain: { name, version, chainId, verifyingContract },
        types: {
          AgentWalletSet: [
            { name: "agentId", type: "uint256" },
            { name: "newWallet", type: "address" },
            { name: "owner", type: "address" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "AgentWalletSet",
        message: { agentId, newWallet: wallet.address, owner: owner.address, deadline },
      });
      const { request } = await client.simulateContract({
        ...identity,
        account: owner,
        functionName: "setAgentWallet",
        args: [agentId, wallet.address, deadline, signature],
      });
      await mined(await client.writeContract(request));
    },
    transfer: async (owner, agentId, to) => {
      const { request } = await client.simulateContract({
        ...identity,
        account: owner,
        functionName: "transferFrom",
        args: [owner.address, to, agentId],
      });
      await mined(await client.writeContract(request));
    },
  };
}
