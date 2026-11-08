import { Channel3, Channel3Error, Channel3TimeoutError } from "@channel3/sdk";

/**
 * The exact lookup request Keelson sends: one hour of staleness at most, fetched live if older.
 * @internal
 */
export const LOOKUP_REQUEST = { max_staleness_hours: 1, realtime_fetch: true } as const;

/**
 * One lookup, with the exact bytes Channel3 answered and when they arrived.
 * @internal
 */
export interface LookupResult {
  /** The HTTP status, or 0 when no response arrived. */
  status: number;
  /** The parsed `product`, or `null` when the lookup failed. */
  product: unknown;
  raw: Uint8Array;
  receivedAtMs: number;
  /** Why the lookup failed: `timeout`, `network`, `http-<status>` or `invalid-response`. */
  error?: string;
}

export interface Channel3Lookup {
  client: Channel3;
  lookup(url: string): Promise<LookupResult>;
}

const options = (apiKey: string, baseUrl: string | undefined, fetchFn: typeof fetch) => ({
  apiKey,
  ...(baseUrl ? { baseUrl } : {}),
  // On the decision path the lookup runs once and is bounded; its absence is recorded instead.
  maxRetries: 0,
  timeoutInSeconds: 8,
  fetch: fetchFn,
});

/**
 * The official client, and a lookup that keeps the response bytes it parsed. Each lookup gets a
 * client of its own so concurrent lookups never share captured bytes. No user identifier is ever
 * sent (`x-user-id` stays unset).
 */
export function createChannel3(
  apiKey: string,
  baseUrl?: string,
  fetchFn: typeof fetch = fetch,
): Channel3Lookup {
  const client = new Channel3(options(apiKey, baseUrl, fetchFn));

  async function lookup(url: string): Promise<LookupResult> {
    let status = 0;
    let raw = new Uint8Array();
    let aborted = false;
    const keep: typeof fetch = async (input, init) => {
      // The SDK aborts its timeout with a string reason, so it surfaces as an untyped error.
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      const res = await fetchFn(input, init);
      status = res.status;
      raw = new Uint8Array(await res.clone().arrayBuffer());
      return res;
    };
    const once = new Channel3(options(apiKey, baseUrl, keep));
    try {
      const { product } = await once.products.lookup({ url, ...LOOKUP_REQUEST });
      return { status, product, raw, receivedAtMs: Date.now() };
    } catch (err) {
      const error =
        err instanceof Channel3TimeoutError || aborted
          ? "timeout"
          : err instanceof Channel3Error && err.statusCode
            ? `http-${err.statusCode}`
            : status === 0
              ? "network"
              : "invalid-response";
      return { status, product: null, raw, receivedAtMs: Date.now(), error };
    }
  }

  return { client, lookup };
}
