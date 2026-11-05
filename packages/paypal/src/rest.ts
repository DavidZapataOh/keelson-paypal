import type { PayPalConfig } from "./config.js";
import { fromResponse } from "./errors.js";
import type { TokenCache } from "./token.js";

export const REQUEST_TIMEOUT_MS = 15_000;

export type PayPalFetch = <T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  init?: {
    body?: unknown | FormData;
    requestId?: string;
    query?: Record<string, string>;
    timeoutMs?: number;
  },
) => Promise<T>;

export function createRestClient(cfg: PayPalConfig, tokens: TokenCache): PayPalFetch {
  return async <T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    init: {
      body?: unknown | FormData;
      requestId?: string;
      query?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ): Promise<T> => {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
      throw new Error("PayPal path must be a relative path starting with a single '/'");
    }
    const url = new URL(path, cfg.baseUrl);
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);

    const headers: Record<string, string> = {
      authorization: `Bearer ${await tokens.get()}`,
      accept: "application/json",
    };
    if (init.requestId) headers["paypal-request-id"] = init.requestId;

    const req: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
    };
    if (init.body instanceof FormData) {
      req.body = init.body;
    } else if (init.body !== undefined) {
      req.body = JSON.stringify(init.body);
      headers["content-type"] = "application/json";
    }

    const res = await fetch(url, req);
    if (!res.ok) throw await fromResponse(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  };
}
