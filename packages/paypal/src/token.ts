import type { OAuthToken } from "@paypal/paypal-server-sdk";
import type { PayPalConfig } from "./config.js";

const REFRESH_WINDOW_MS = 300_000;

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

/** Client-credentials access token shared by the SDK and the REST core. */
export class TokenCache {
  /** Epoch milliseconds at which the cached token expires. */
  expiresAt = 0;
  private token = "";
  private inflight: Promise<string> | undefined;

  constructor(
    private readonly cfg: PayPalConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get(): Promise<string> {
    if (this.token && this.expiresAt - Date.now() > REFRESH_WINDOW_MS) {
      return Promise.resolve(this.token);
    }
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
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
    });
    if (!res.ok) {
      throw new Error(
        `PayPal OAuth token request failed: HTTP ${res.status} (debug id ${res.headers.get("paypal-debug-id") ?? "n/a"})`,
      );
    }
    const body = (await res.json()) as TokenResponse;
    this.token = body.access_token;
    this.expiresAt = Date.now() + body.expires_in * 1000;
    return this.token;
  }
}
