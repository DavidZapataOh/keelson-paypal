import { addresses } from "@keelson/chain";
import { keelsonDomain } from "@keelson/core/eip712";
import { getAddress, type Hex } from "viem";
import { createSiweMessage } from "viem/siwe";
import type { AmberCase } from "./amber";
import { get, send } from "./api";
import { authClient } from "./auth";
import { API } from "./config";

/** Arbitrum Sepolia: the sandbox chain the merchant's settlement wallet signs on. */
export const CHAIN_ID = 421614;

export interface MerchantSelf {
  merchant_id: string;
  name: string;
  website: string;
  settlement_address: string;
  /** A Judge Mode session: it reads the console and changes nothing. */
  read_only: boolean;
}

export type Rail = "pyusd" | "paypal";

export interface Settlement {
  rail: Rail;
  paypal_receiver: string | null;
  nonce: string;
  updated_at: string | null;
}

export interface MerchantDispute {
  dispute_id: string;
  purchase_id: string;
  state: "OPEN" | "ATTRIBUTED" | "RESOLVED";
  reason: string;
  amount_minor: string;
  currency: string;
  agent_id: string;
  received_at: string | null;
  attributed_at: string | null;
  elapsed_ms: number | null;
  liable: "operator" | "keelson" | "merchant" | "user" | null;
  rule: string | null;
  rail: Rail | null;
  outcome: "paid" | "queued" | "claimable" | "failed" | null;
  paid_by: "chain" | "treasury" | "violation-pool" | null;
  ready_at: string | null;
  settled_at: string | null;
  explorer_url: string | null;
  has_alibi: boolean;
  amber: AmberCase | null;
}

export interface Evaluations {
  columns: string[];
  rows: (string | number | null)[][];
}

/** An EIP-1193 provider: the merchant's wallet extension. */
export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export function injectedWallet(): Eip1193 | undefined {
  return (globalThis as { ethereum?: Eip1193 }).ethereum;
}

export const me = () => get<MerchantSelf>("/v1/merchants/me");
export const settlementOf = (id: string) => get<Settlement>(`/v1/merchants/${id}/settlement`);
export const disputesOf = (id: string) =>
  get<{ disputes: MerchantDispute[] }>(`/v1/merchants/${id}/disputes`).then((r) => r.disputes);
export const evaluationsOf = (id: string) => get<Evaluations>(`/v1/merchants/${id}/evaluations`);

/** The SIWE message the wallet signs to open a merchant session. */
function signInMessage(address: string, nonce: string, now = new Date()): string {
  return createSiweMessage({
    domain: location.host,
    address: getAddress(address),
    statement: "Sign in to the Keelson merchant console.",
    uri: location.origin,
    version: "1",
    chainId: CHAIN_ID,
    nonce,
    issuedAt: now,
    expirationTime: new Date(now.getTime() + 10 * 60_000),
  });
}

/** Signs in with the wallet's first account (EIP-4361) and returns the merchant it is. */
export async function signIn(wallet: Eip1193): Promise<MerchantSelf> {
  const [address] = (await wallet.request({ method: "eth_requestAccounts" })) as string[];
  if (!address) throw new Error("The wallet shared no account.");
  const nonce = await authClient.siwe.nonce();
  if (nonce.error) throw new Error(nonce.error.message ?? "The API refused a sign-in nonce.");
  const message = signInMessage(address, nonce.data.nonce);
  const signature = (await wallet.request({
    method: "personal_sign",
    params: [message, address],
  })) as string;
  const verified = await authClient.siwe.verify({ message, signature });
  if (verified.error) throw new Error(verified.error.message ?? "The signature was refused.");
  return me();
}

/** The `SettlementPreference` typed data, as the API verifies it. */
function settlementTypedData(message: {
  merchantId: string;
  rail: Rail;
  paypalReceiver: string;
  nonce: bigint;
  deadline: bigint;
}) {
  return {
    domain: keelsonDomain(CHAIN_ID, addresses[CHAIN_ID].KeelsonBondVault as Hex),
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      SettlementPreference: [
        { name: "merchantId", type: "string" },
        { name: "rail", type: "string" },
        { name: "paypalReceiver", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "SettlementPreference" as const,
    message,
  };
}

/**
 * Signs the merchant's choice with its wallet (`eth_signTypedData_v4`) and stores it. The next
 * nonce is one above the stored choice's.
 */
export async function chooseSettlement(
  wallet: Eip1193,
  merchant: MerchantSelf,
  current: Settlement,
  choice: { rail: Rail; paypalReceiver: string },
): Promise<Settlement> {
  const nonce = BigInt(current.nonce) + 1n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const paypalReceiver = choice.rail === "paypal" ? choice.paypalReceiver : "";
  const typed = settlementTypedData({
    merchantId: merchant.merchant_id,
    rail: choice.rail,
    paypalReceiver,
    nonce,
    deadline,
  });
  const signature = (await wallet.request({
    method: "eth_signTypedData_v4",
    params: [
      merchant.settlement_address,
      JSON.stringify(typed, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    ],
  })) as string;
  await send(`/v1/merchants/${merchant.merchant_id}/settlement`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      rail: choice.rail,
      ...(choice.rail === "paypal" ? { paypal_receiver: paypalReceiver } : {}),
      nonce: nonce.toString(),
      deadline: deadline.toString(),
      merchant_signature: signature,
    }),
  });
  return settlementOf(merchant.merchant_id);
}

export const assistantEndpoint = (merchantId: string) =>
  `${API}/v1/merchants/${merchantId}/assistant`;
