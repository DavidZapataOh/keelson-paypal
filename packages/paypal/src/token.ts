import type { OAuthToken } from "@paypal/paypal-server-sdk";
import { z } from "zod";
import type { PayPalConfig } from "./config.ts";
import { fromResponse } from "./errors.ts";

const REFRESH_WINDOW_MS = 300_000;

const tokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

const TOKEN_TIMEOUT_MS = 10_000;

/** Client-credentials access token shared by the SDK and the REST core. */
export class TokenCache {
  /** Epoch milliseconds at which the cached token expires. */
  expiresAt = 0;
  private token = "";
  private inflight: Promise<string> | undefined;

  private readonly cfg: PayPalConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    cfg: PayPalConfig,
    fetchImpl: typeof fetch = fetch,
    timeoutMs: number = TOKEN_TIMEOUT_MS,
  ) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  get(): Promise<string> {
    if (this.token && this.expiresAt - Date.now() > REFRESH_WINDOW_MS) {
      return Promise.resolve(this.token);
    }
    this.inflight ??= this.refresh()
      .catch((e: unknown) => {
        if (this.token && this.expiresAt > Date.now()) return this.token;
        throw e;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  /**
   * Drops `token` if it is still the cached one, so the next `get` fetches another. PayPal refuses
   * a token that was revoked, or that was issued before the app's scopes changed.
   */
  invalidate(token: string): void {
    if (this.token !== token) return;
    this.token = "";
    this.expiresAt = 0;
  }

  sdkProvider(): (last?: OAuthToken) => Promise<OAuthToken> {
    return async () => {
      const accessToken = await this.get();
      return {
        accessToken,
        tokenType: "Bearer",
        expiresIn: BigInt(Math.floor((this.expiresAt - Date.now()) / 1000)),
        expiry: BigInt(Math.floor(this.expiresAt / 1000)),
      };
    };
  }

  private async refresh(): Promise<string> {
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw await fromResponse(res);
    const body = tokenResponse.parse(await res.json());
    this.token = body.access_token;
    this.expiresAt = Date.now() + body.expires_in * 1000;
    return this.token;
  }
}
