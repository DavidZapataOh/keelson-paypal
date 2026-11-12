import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { PayPalConfig } from "../src/config.ts";
import { PayPalError } from "../src/errors.ts";
import { createRestClient } from "../src/rest.ts";
import { TokenCache } from "../src/token.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/**
 * A stand-in PayPal on a real socket: the token endpoint hands out `t1`, `t2`, … and the API
 * refuses every token in `refused` with `refusal`.
 */
async function paypal(refusal: { status: number; name: string }, refused: Set<string>) {
  const tokens: string[] = [];
  const seen: string[] = [];
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/oauth2/token") {
      const token = `t${tokens.length + 1}`;
      tokens.push(token);
      return res.end(JSON.stringify({ access_token: token, expires_in: 32_400 }));
    }
    const token = (req.headers.authorization ?? "").replace("Bearer ", "");
    seen.push(token);
    if (refused.has(token)) {
      res.statusCode = refusal.status;
      return res.end(JSON.stringify({ name: refusal.name, message: "refused" }));
    }
    res.end(JSON.stringify({ ok: true }));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const cfg: PayPalConfig = {
    env: "sandbox",
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    clientId: "id",
    clientSecret: "secret",
  };
  return { cfg, tokens, seen };
}

describe("a token PayPal refuses", () => {
  it.each([
    { status: 401, name: "AUTHENTICATION_FAILURE" },
    { status: 403, name: "NOT_AUTHORIZED" },
  ])("is dropped and the call made once more with a new one ($status $name)", async (refusal) => {
    const { cfg, tokens, seen } = await paypal(refusal, new Set(["t1"]));
    const rest = createRestClient(cfg, new TokenCache(cfg));
    expect(await rest("GET", "/v3/vault/payment-tokens/x")).toEqual({ ok: true });
    expect(tokens).toEqual(["t1", "t2"]);
    expect(seen).toEqual(["t1", "t2"]);
  });

  it("is retried once, not again", async () => {
    const { cfg, seen } = await paypal(
      { status: 401, name: "INVALID_TOKEN" },
      new Set(["t1", "t2"]),
    );
    const rest = createRestClient(cfg, new TokenCache(cfg));
    const err = await rest("GET", "/v3/vault/payment-tokens/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).status).toBe(401);
    expect(seen).toEqual(["t1", "t2"]);
  });

  it("is not retried for other refusals", async () => {
    const { cfg, seen } = await paypal({ status: 403, name: "PERMISSION_DENIED" }, new Set(["t1"]));
    const rest = createRestClient(cfg, new TokenCache(cfg));
    await expect(rest("GET", "/v3/vault/payment-tokens/x")).rejects.toBeInstanceOf(PayPalError);
    expect(seen).toEqual(["t1"]);
  });
});

describe("TokenCache.invalidate", () => {
  it("drops only the token it names", async () => {
    const { cfg, tokens } = await paypal({ status: 401, name: "x" }, new Set());
    const cache = new TokenCache(cfg);
    const first = await cache.get();
    cache.invalidate("another");
    expect(await cache.get()).toBe(first);
    cache.invalidate(first);
    expect(await cache.get()).toBe("t2");
    expect(tokens).toEqual(["t1", "t2"]);
  });
});
