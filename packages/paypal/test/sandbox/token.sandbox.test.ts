import { Agent, fetch as undiciFetch } from "undici";
import { describe, expect, it } from "vitest";
import { paypalConfig } from "../../src/config.ts";
import { PayPalError } from "../../src/errors.ts";
import { createPayPal } from "../../src/sdk.ts";
import { TokenCache } from "../../src/token.ts";

function countingCache() {
  const requests: string[] = [];
  const dispatcher = new Agent().compose((dispatch) => (opts, handler) => {
    if (String(opts.path).startsWith("/v1/oauth2/token")) requests.push(String(opts.path));
    return dispatch(opts, handler);
  });
  const fetchImpl = ((url: string, init?: object) =>
    undiciFetch(url, { ...init, dispatcher })) as unknown as typeof fetch;
  return { requests, cache: new TokenCache(paypalConfig(), fetchImpl) };
}

describe("token cache (sandbox)", () => {
  it("returns a token and shares one request across parallel callers", async () => {
    const { cache, requests } = countingCache();
    const started = performance.now();
    const first = await cache.get();
    console.info(`token fetch latency: ${Math.round(performance.now() - started)} ms`);
    expect(first.length).toBeGreaterThan(0);
    expect(requests).toHaveLength(1);

    const fresh = countingCache();
    const tokens = await Promise.all(Array.from({ length: 20 }, () => fresh.cache.get()));
    expect(new Set(tokens).size).toBe(1);
    expect(fresh.requests).toHaveLength(1);
  });

  it("refreshes once fewer than 300 s remain", async () => {
    const { cache, requests } = countingCache();
    await cache.get();
    await cache.get();
    expect(requests).toHaveLength(1);
    cache.expiresAt = Date.now() + 10_000;
    await cache.get();
    expect(requests).toHaveLength(2);
  });

  it("maps the cached token to the SDK model", async () => {
    const { cache } = countingCache();
    const token = await cache.sdkProvider()();
    expect(token.tokenType).toBe("Bearer");
    expect(token.accessToken).toBe(await cache.get());
    expect(token.expiry).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)));
  });

  it("replaces a token PayPal refuses, for the SDK and the REST client", async () => {
    const real = countingCache();
    // The first token handed out is one PayPal never issued, as a revoked one would be.
    let handedOut = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (handedOut++ === 0) {
        return new Response(JSON.stringify({ access_token: "A21AArevoked", expires_in: 32_400 }), {
          headers: { "content-type": "application/json" },
        });
      }
      return fetch(url, init);
    }) as typeof fetch;
    const cache = new TokenCache(paypalConfig(), fetchImpl);
    const paypal = createPayPal(paypalConfig(), cache);
    // An order that does not exist: PayPal answers 404 once the token is accepted.
    const err = await paypal.orders.getOrder({ id: "0AAAAAAAAAAAAAAAA" }).catch((e: unknown) => e);
    expect(String((err as { statusCode?: number }).statusCode)).toBe("404");
    expect(handedOut).toBe(2);
    const rest = await paypal
      .fetch("GET", "/v2/checkout/orders/0AAAAAAAAAAAAAAAA")
      .catch((e: unknown) => e);
    expect(rest).toBeInstanceOf(PayPalError);
    expect((rest as PayPalError).status).toBe(404);
    expect(real.requests).toHaveLength(0);
  });
});
