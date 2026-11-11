import { bondPermitTypedData, PYUSD_ARBITRUM_SEPOLIA } from "@keelson/chain";
import {
  type Address,
  createPublicClient,
  custom,
  erc20Abi,
  getAddress,
  type Hex,
  parseAbi,
  serializeTypedData,
} from "viem";
import { arbitrumSepolia } from "viem/chains";
import { createSiweMessage } from "viem/siwe";
import type { AmberField } from "./amber";
import { get, post, send } from "./api";
import { authClient } from "./auth";
import type { Eip1193 } from "./merchant";

export { type Eip1193, injectedWallet } from "./merchant";

/** Arbitrum Sepolia: the chain the operator's agent and bond live on. */
export const CHAIN_ID = 421614;
export const EXPLORER = "https://sepolia.arbiscan.io";

export interface OperatorSelf {
  wallets: string[];
  operators: { agentId: string; chainId: number; name: string }[];
}

export interface Bond {
  bond: { free: string; locked: string; queued: string; slashCount: number };
  reputation: { count: number; value: string; decimals: number; slashes: number };
  validation: { count: number; averageResponse: number };
}

export interface TrustGrade {
  agentId: string;
  grade: "A" | "B" | "C" | "D" | "F";
  computedAt: string;
  evidence: {
    coverages: number;
    incidents: {
      total: number;
      slashes: number;
      pool: number;
      uncollected: number;
      pending: number;
    };
  };
  reserve: { warranties: number };
  frequency: { mean_ppm: number; upper95_ppm: number; credibility_ppm: number };
  loss: { horizon: number; expectedMinor: number; var99Minor: number };
  premium: { bps: number; modelBps: number; floorBps: number };
  bond: { requiredMinor: number };
}

export interface CoverageRow {
  id: string;
  createdAt: string;
  merchantId: string;
  amount: number;
  premiumBps: number | null;
  premium: number;
  state: string;
  coverageTx: string | null;
  disputeId: string | null;
  disputeState: "OPEN" | "ATTRIBUTED" | "RESOLVED" | null;
  disputeReason: string | null;
  disputedAt: string | null;
  liable: "operator" | "keelson" | "merchant" | "user" | null;
  rule: string | null;
  verdictAmount: number | null;
  verdictAt: string | null;
  outcome: "paid" | "queued" | "claimable" | "failed" | null;
  paidBy: "chain" | "treasury" | "violation-pool" | null;
  settlementTx: string | null;
  settledAt: string | null;
  amber: "none" | "attested" | "contradicted";
  amberCommitment: string | null;
  amberField: AmberField | null;
  amberClaimed: string | null;
  amberProvenAt: string | null;
  amberWebFact: string | null;
  amberTx: string | null;
}

export interface CoverageDay {
  day: string;
  coverages: number;
  covered: number;
  premiums: number;
  incidents: number;
}

export interface GridAnswer {
  gridState: Record<string, unknown>;
  propertiesToIgnore: string[];
  explanation: string;
  model: string;
  costMicros: number;
}

export interface RelayedTx {
  id: string;
  status: "pending" | "confirmed" | "reverted" | "rejected" | "dropped";
  hash?: Hex;
  blockNumber?: string;
  explorerUrl?: string;
}

export const me = () => get<OperatorSelf>("/v1/operators/me");
export const bondOf = (agentId: string) => get<Bond>(`/v1/operators/${CHAIN_ID}/${agentId}/bond`);
export const gradeOf = (agentId: string) => get<TrustGrade>(`/v1/operators/${agentId}/grade`);
export const dailyOf = (agentId: string) =>
  get<{ days: CoverageDay[] }>(`/v1/operators/${agentId}/coverages/daily`).then((r) => r.days);

/** A block of the coverage book, as AG Grid's server-side row model asks for it. */
export const coverageBlock = (agentId: string, request: unknown) =>
  send<{ rows: CoverageRow[]; rowCount: number }>(`/v1/operators/${agentId}/coverages/rows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });

export const gridQuery = (
  agentId: string,
  body: { prompt: string; gridState: unknown; schema: unknown },
) =>
  send<GridAnswer>(`/v1/operators/${agentId}/grid-query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Asks the wallet for Arbitrum Sepolia, which the permit's domain names. */
async function onChain(wallet: Eip1193): Promise<void> {
  const current = Number(await wallet.request({ method: "eth_chainId" }));
  if (current === CHAIN_ID) return;
  await wallet.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: `0x${CHAIN_ID.toString(16)}` }],
  });
}

/** Signs in with the wallet's first account (EIP-4361) and returns the agents it owns. */
export async function signIn(wallet: Eip1193): Promise<OperatorSelf> {
  const [address] = (await wallet.request({ method: "eth_requestAccounts" })) as string[];
  if (!address) throw new Error("The wallet shared no account.");
  const nonce = await authClient.siwe.nonce();
  if (nonce.error) throw new Error(nonce.error.message ?? "The API refused a sign-in nonce.");
  const now = new Date();
  const message = createSiweMessage({
    domain: location.host,
    address: getAddress(address),
    statement: "Sign in to the Keelson operator console.",
    uri: location.origin,
    version: "1",
    chainId: CHAIN_ID,
    nonce: nonce.data.nonce,
    issuedAt: now,
    expirationTime: new Date(now.getTime() + 10 * 60_000),
  });
  const signature = (await wallet.request({
    method: "personal_sign",
    params: [message, address],
  })) as string;
  const verified = await authClient.siwe.verify({ message, signature });
  if (verified.error) throw new Error(verified.error.message ?? "The signature was refused.");
  return me();
}

/** The wallet's PYUSD balance and permit nonce, read through the wallet itself. */
export async function pyusdOf(wallet: Eip1193, owner: Address) {
  await onChain(wallet);
  const client = createPublicClient({ chain: arbitrumSepolia, transport: custom(wallet) });
  const [balance, nonce] = await Promise.all([
    client.readContract({
      address: PYUSD_ARBITRUM_SEPOLIA,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    }),
    client.readContract({
      address: PYUSD_ARBITRUM_SEPOLIA,
      abi: parseAbi(["function nonces(address) view returns (uint256)"]),
      functionName: "nonces",
      args: [owner],
    }),
  ]);
  return { balance, nonce };
}

/** What the wallet is asked to sign: PYUSD's EIP-2612 permit to the bond vault. */
export function permitFor(owner: Address, value: bigint, nonce: bigint, now = Date.now()) {
  const deadline = BigInt(Math.floor(now / 1000) + 15 * 60);
  return bondPermitTypedData({ owner, value, nonce, deadline });
}

/**
 * Signs the permit in the wallet (`eth_signTypedData_v4`) and has Keelson relay
 * `depositWithPermit`: the operator pays no gas.
 */
export async function depositWithPermit(
  wallet: Eip1193,
  agentId: string,
  typed: ReturnType<typeof permitFor>,
): Promise<RelayedTx> {
  await onChain(wallet);
  const signature = (await wallet.request({
    method: "eth_signTypedData_v4",
    params: [typed.message.owner, serializeTypedData(typed)],
  })) as Hex;
  return post<RelayedTx>(`/v1/bonds/${agentId}/deposits`, {
    chainId: CHAIN_ID,
    kind: "permit",
    owner: typed.message.owner,
    amount: typed.message.value.toString(),
    deadline: typed.message.deadline.toString(),
    signature,
  });
}

/** Polls a relayed transaction until it leaves `pending`. */
export async function settled(tx: RelayedTx, signal?: AbortSignal): Promise<RelayedTx> {
  let current = tx;
  while (current.status === "pending" && !signal?.aborted) {
    await new Promise((r) => setTimeout(r, 1_000));
    current = await get<RelayedTx>(`/v1/transactions/${tx.id}`);
  }
  return current;
}
