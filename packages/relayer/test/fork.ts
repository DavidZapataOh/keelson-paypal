import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  type Address,
  type Chain,
  concat,
  createTestClient,
  encodeAbiParameters,
  type Hex,
  http,
  keccak256,
  type PublicActions,
  publicActions,
  stringToHex,
  type TestClient,
  type Transport,
  type WalletActions,
  walletActions,
} from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

/** After the first funder's PYUSD came back from the demo operator's bond, with every Keelson contract deployed. */
export const FORK_BLOCK = 327_295_400n;
export const PYUSD: Address = "0x637A1259C6afd7E3AdF63993cA7E58BB438aB1B1";
export const VAULT: Address = "0xb39898Ef4333f3CB32d1B420E744f5a1Aa2ae2Bf";
export const AGENT_ID = 351n;
/** anvil's first default account; on the fork it only pays gas when KMS is not what a test is about. */
export const ANVIL_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const RECEIVE_WITH_AUTHORIZATION = keccak256(
  stringToHex(
    "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
  ),
);
/** PYUSD's `DOMAIN_SEPARATOR()` on Arbitrum Sepolia. */
const PYUSD_DOMAIN: Hex = "0xf3ecc5aec9b5298246e45dbdcf197d113d30718459718fca6a79848cbabfacb2";

export function funder(index = 0): PrivateKeyAccount {
  const keys = process.env.KEELSON_FUNDER_KEYS?.split(",");
  const key = keys?.[index];
  if (!key) throw new Error("KEELSON_FUNDER_KEYS is not set");
  return privateKeyToAccount(key as Hex);
}

/** The arguments of `depositWithAuthorization`: an EIP-3009 authorization of `amount` to the vault for `agentId`. */
export async function depositArgs(
  from: PrivateKeyAccount,
  amount: bigint,
  agentId = AGENT_ID,
  salt: Hex = `0x${randomBytes(32).toString("hex")}`,
) {
  const validBefore = 2n ** 256n - 1n;
  const nonce = keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [agentId, salt]),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [RECEIVE_WITH_AUTHORIZATION, from.address, VAULT, amount, 0n, validBefore, nonce],
    ),
  );
  const signature = await from.sign({
    hash: keccak256(concat(["0x1901", PYUSD_DOMAIN, structHash])),
  });
  return {
    nonce,
    args: [agentId, from.address, amount, 0n, validBefore, salt, signature] as const,
  };
}

export type ForkClient = TestClient<"anvil", Transport, Chain> &
  PublicActions<Transport, Chain> &
  WalletActions<Chain>;

function forkClient(url: string): ForkClient {
  return createTestClient({ chain: arbitrumSepolia, mode: "anvil", transport: http(url) })
    .extend(publicActions)
    .extend(walletActions) as unknown as ForkClient;
}

export interface Fork {
  url: string;
  client: ForkClient;
  stop(): void;
}

/** An anvil fork of Arbitrum Sepolia at `FORK_BLOCK`. */
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
  const client = forkClient(url);
  for (let i = 0; ; i++) {
    try {
      await client.getChainId();
      break;
    } catch (e) {
      if (i > 150) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { url, client, stop: () => anvil.kill() };
}
