import type { Logger } from "pino";
import { fallback, type HttpTransportConfig, http, type Transport } from "viem";
import { arbitrumSepolia } from "viem/chains";

/** Arbitrum Sepolia's public RPC: rate-limited per IP, and up when a provider's quota is spent. */
export const ARBITRUM_SEPOLIA_PUBLIC_RPC = arbitrumSepolia.rpcUrls.default.http[0];

/**
 * How often the API's clients poll for a receipt or a block. viem's default on Arbitrum is 500 ms
 * (half the chain's 250 ms block time, floored); one second halves the reads of every wait.
 */
export const POLLING_INTERVAL_MS = 1_000;

/** The configured Arbitrum Sepolia RPC, if any, then the public one. */
export function arbitrumSepoliaRpcUrls(primary: string | undefined): string[] {
  return primary && primary !== ARBITRUM_SEPOLIA_PUBLIC_RPC
    ? [primary, ARBITRUM_SEPOLIA_PUBLIC_RPC]
    : [ARBITRUM_SEPOLIA_PUBLIC_RPC];
}

/** Requests sent since the process started, by provider host, then by method. */
const calls = new Map<string, Map<string, number>>();

/** The RPC requests this process sent since it started, by provider host and method. */
export function rpcCalls(): { provider: string; method: string; calls: number }[] {
  return [...calls].flatMap(([provider, methods]) =>
    [...methods].map(([method, n]) => ({ provider, method, calls: n })),
  );
}

/**
 * Counts every request `transport` sends under the host of `url`; the path, which carries a
 * provider's key, is never kept.
 */
export function counted(url: string, transport: Transport): Transport {
  const provider = new URL(url).host;
  return (config) => {
    const t = transport(config);
    const request: typeof t.request = (args, options) => {
      const methods = calls.get(provider) ?? new Map<string, number>();
      calls.set(provider, methods);
      methods.set(args.method, (methods.get(args.method) ?? 0) + 1);
      return t.request(args, options);
    };
    return { ...t, request };
  };
}

/** An HTTP transport to `url` whose requests are counted. */
export function countedHttp(url: string, config?: HttpTransportConfig): Transport {
  return counted(url, http(url, config));
}

/**
 * Sends each request to the first URL and, on a rate limit, a server error or a timeout, to the
 * next. Errors name the last URL tried, so a provider's key in the first one stays out of logs.
 *
 * @internal
 */
export function rpcTransport(urls: readonly string[]): Transport {
  return urls.length === 1
    ? countedHttp(urls[0] as string)
    : fallback(urls.map((url) => countedHttp(url)));
}

/** The configured Arbitrum Sepolia RPC with the public one behind it. */
export function arbitrumSepoliaTransport(primary: string | undefined): Transport {
  return rpcTransport(arbitrumSepoliaRpcUrls(primary));
}

/**
 * Alchemy's compute units per method; a method it does not list is counted as an `eth_call`.
 * https://www.alchemy.com/docs/reference/compute-unit-costs
 */
const COMPUTE_UNITS: Readonly<Record<string, number>> = {
  eth_chainId: 0,
  eth_blockNumber: 10,
  eth_feeHistory: 10,
  eth_maxPriorityFeePerGas: 10,
  eth_subscribe: 10,
  eth_unsubscribe: 10,
  eth_gasPrice: 20,
  eth_getBalance: 20,
  eth_getBlockByNumber: 20,
  eth_getTransactionByHash: 20,
  eth_getTransactionCount: 20,
  eth_getTransactionReceipt: 20,
  eth_estimateGas: 20,
  eth_call: 26,
  eth_sendRawTransaction: 40,
  eth_sendRawTransactionSync: 40,
  eth_getLogs: 60,
};

/** The compute units of `n` calls of `method`, at Alchemy's prices. */
export const computeUnits = (method: string, n: number) => (COMPUTE_UNITS[method] ?? 26) * n;

const HOUR_MS = 3_600_000;
/** Hours in a 30-day month: the hourly rate projected over a month. */
const HOURS_PER_MONTH = 720;
/** Half of Alchemy's free 30M compute units a month. */
export const DEFAULT_CU_BUDGET = 15_000_000;

/**
 * Every hour, logs this process's calls of the past hour by provider and method, and warns when
 * its rate on Alchemy, projected over a month, passes `budget` compute units. Counts are requests
 * the clients made; a transport's own retries are not counted.
 */
export function startRpcReport(
  log: Logger,
  {
    budget = DEFAULT_CU_BUDGET,
    intervalMs = HOUR_MS,
  }: { budget?: number; intervalMs?: number } = {},
): () => void {
  let last = new Map<string, number>();
  const timer = setInterval(() => {
    const now = new Map(rpcCalls().map((c) => [`${c.provider} ${c.method}`, c.calls]));
    const hour = [...now]
      .map(([key, n]) => {
        const [provider = "", method = ""] = key.split(" ");
        return { provider, method, calls: n - (last.get(key) ?? 0) };
      })
      .filter((c) => c.calls > 0);
    last = now;
    const scale = (HOUR_MS / intervalMs) * HOURS_PER_MONTH;
    const byProvider = new Map<string, number>();
    for (const c of hour.filter((c) => c.provider.endsWith(".alchemy.com"))) {
      byProvider.set(
        c.provider,
        (byProvider.get(c.provider) ?? 0) + computeUnits(c.method, c.calls),
      );
    }
    log.info({ calls: hour, intervalMs }, "rpc calls");
    for (const [provider, cu] of byProvider) {
      const monthly = Math.round(cu * scale);
      if (monthly > budget) {
        log.warn({ provider, monthlyComputeUnits: monthly, budget }, "rpc usage over budget");
      }
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
