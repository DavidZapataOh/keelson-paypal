import { KEELSON_API, type TokenProvider } from "./auth.ts";
import { keelsonFetch, type RetryOptions } from "./fetch.ts";
import { createClient, createConfig } from "./generated/client/index.ts";
import { KeelsonApi } from "./generated/sdk.gen.ts";

export interface KeelsonOptions {
  /** Keelson's API origin. Defaults to `https://api.keelson.finance`, on the PayPal sandbox. */
  baseUrl?: string;
  /** Where the bearer token comes from; public endpoints need none. */
  auth?: TokenProvider;
  retry?: RetryOptions;
  /** A `fetch` to send requests with, e.g. one with a proxy. */
  fetch?: typeof fetch;
}

/**
 * Keelson's API, one method per operation of its OpenAPI document (`openapi/keelson.yaml`). Every
 * call sends the bearer token, an `Idempotency-Key` on each POST, and retries what is safe to.
 *
 * @example
 * const keelson = new Keelson({
 *   auth: clientCredentials({ clientId, clientSecret, scopes: ["countersign:write"] }),
 * });
 * const { data } = await keelson.getPurchase({ path: { id } });
 */
export class Keelson extends KeelsonApi {
  readonly baseUrl: string;

  constructor(options: KeelsonOptions = {}) {
    const baseUrl = (options.baseUrl ?? KEELSON_API).replace(/\/$/, "");
    // A client secret or user token goes to this origin: only over TLS, or to this machine.
    const { protocol, hostname } = new URL(baseUrl);
    if (protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
      throw new Error("baseUrl must use https");
    }
    super({
      client: createClient(
        createConfig({
          baseUrl,
          fetch: keelsonFetch({ auth: options.auth, retry: options.retry, fetch: options.fetch }),
        }),
      ),
    });
    this.baseUrl = baseUrl;
  }
}
