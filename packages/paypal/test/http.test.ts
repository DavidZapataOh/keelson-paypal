import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { PayPalConfig } from "../src/config.js";
import { PayPalError } from "../src/errors.js";
import { createRestClient } from "../src/rest.js";
import { TokenCache } from "../src/token.js";

const servers: Server[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.closeAllConnections();
  for (const s of servers) s.close();
});

async function listen(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const cfg: PayPalConfig = {
    env: "sandbox",
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    clientId: "id",
    clientSecret: "secret",
  };
  return cfg;
}

const tokenOk = JSON.stringify({ access_token: "tok", token_type: "Bearer", expires_in: 32400 });

describe("token cache against a local server", () => {
  it("aborts a token request that never responds", async () => {
    const cfg = await listen(() => {});
    const cache = new TokenCache(cfg, fetch, 150);
    await expect(cache.get()).rejects.toThrow();
  });

  it("recovers after a failed refresh and keeps the secret out of the error", async () => {
    let calls = 0;
    const cfg = await listen((_req, res) => {
      calls++;
      res.setHeader("content-type", "application/json");
      if (calls === 1) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: "invalid_client", error_description: "failed" }));
      } else {
        res.end(tokenOk);
      }
    });
    const cache = new TokenCache(cfg);
    const err = (await cache.get().catch((e) => e)) as PayPalError;
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.status).toBe(401);
    expect(err.name).toBe("invalid_client");
    expect(err.message).not.toContain("secret");
    await expect(cache.get()).resolves.toBe("tok");
    expect(calls).toBe(2);
  });

  it("rejects a malformed token response", async () => {
    const cfg = await listen((_req, res) => {
      res.end(JSON.stringify({ token_type: "Bearer" }));
    });
    await expect(new TokenCache(cfg).get()).rejects.toThrow();
  });
});

describe("rest client against a local server", () => {
  it("aborts a request that never responds", async () => {
    const cfg = await listen((_req, res) => {
      if (_req.url === "/v1/oauth2/token") res.end(tokenOk);
    });
    const rest = createRestClient(cfg, new TokenCache(cfg));
    await expect(rest("GET", "/v1/slow", { timeoutMs: 150 })).rejects.toThrow();
  });

  it("refuses paths that could leave the configured host", async () => {
    const cfg = await listen((_req, res) => res.end(tokenOk));
    const rest = createRestClient(cfg, new TokenCache(cfg));
    for (const path of ["https://evil.example/x", "//evil.example/x", "v1/x", "/\\evil.example"]) {
      await expect(rest("GET", path)).rejects.toThrow(/path/);
    }
  });
});
