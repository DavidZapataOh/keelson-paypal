import { DEFAULT_BASE_URL } from "./auth.ts";
import { resolveAuth } from "./credentials.ts";
import { KeelsonError } from "./errors.ts";
import {
  type APIResponse,
  type AuthProvider,
  checkBaseUrl,
  type RequestOptions,
  send,
  type TransportOptions,
} from "./transport.ts";
import type { Status } from "./types.ts";

export interface KeelsonOptions {
  /**
   * How to authenticate. Left out, the SDK reads `KEELSON_CLIENT_ID` and `KEELSON_CLIENT_SECRET`,
   * then `KEELSON_TOKEN`, then the credentials `npx keelson login` saved. `null` calls only
   * public operations.
   */
  auth?: AuthProvider | null;
  /** `https://api.keelson.finance` by default. */
  baseUrl?: string;
  /** Retries of a failed attempt; 2 by default. */
  maxRetries?: number;
  /** Per attempt; 60 s by default. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Keelson's API. */
export class Keelson {
  readonly baseUrl: string;
  readonly #transport: TransportOptions;

  constructor(options: KeelsonOptions = {}) {
    this.baseUrl = checkBaseUrl(
      options.baseUrl ?? process.env.KEELSON_API_URL ?? DEFAULT_BASE_URL,
    ).origin;
    let provider: AuthProvider | undefined = options.auth ?? undefined;
    this.#transport = {
      baseUrl: this.baseUrl,
      maxRetries: options.maxRetries ?? 2,
      timeoutMs: options.timeoutMs ?? 60_000,
      fetch: options.fetch ?? fetch,
      auth: () => {
        if (options.auth === null) {
          throw new KeelsonError("This client has no credentials; pass `auth`.");
        }
        provider ??= resolveAuth(this.baseUrl);
        return provider;
      },
    };
  }

  /** Calls any operation of the API. Resources use it; it is public for what they do not cover. */
  request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    opts?: RequestOptions,
  ): Promise<APIResponse<T>> {
    return send<T>(this.#transport, method, path, opts);
  }

  /** Whether Keelson and each dependency is up, and on which environment (sandbox, testnet). */
  async status(): Promise<Status> {
    return (await this.request<Status>("GET", "/status", { auth: false })).data;
  }
}
