import { fallback, http, type Transport } from "viem";
import { arbitrumSepolia } from "viem/chains";

/** Arbitrum Sepolia's public RPC: rate-limited per IP, and up when a provider's quota is spent. */
export const ARBITRUM_SEPOLIA_PUBLIC_RPC = arbitrumSepolia.rpcUrls.default.http[0];

/** The configured Arbitrum Sepolia RPC, if any, then the public one. */
export function arbitrumSepoliaRpcUrls(primary: string | undefined): string[] {
  return primary && primary !== ARBITRUM_SEPOLIA_PUBLIC_RPC
    ? [primary, ARBITRUM_SEPOLIA_PUBLIC_RPC]
    : [ARBITRUM_SEPOLIA_PUBLIC_RPC];
}

/**
 * Sends each request to the first URL and, on a rate limit, a server error or a timeout, to the
 * next. Errors name the last URL tried, so a provider's key in the first one stays out of logs.
 */
export function rpcTransport(urls: readonly string[]): Transport {
  return urls.length === 1 ? http(urls[0]) : fallback(urls.map((url) => http(url)));
}

/** The configured Arbitrum Sepolia RPC with the public one behind it. */
export function arbitrumSepoliaTransport(primary: string | undefined): Transport {
  return rpcTransport(arbitrumSepoliaRpcUrls(primary));
}
