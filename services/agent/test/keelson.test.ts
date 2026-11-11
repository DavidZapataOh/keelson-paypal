import { createServer } from "node:http";
import { afterAll, expect, test } from "vitest";
import { accessToken } from "../src/keelson.ts";

const grants: URLSearchParams[] = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const basic = Buffer.from(`${encodeURIComponent("client 1")}:secret`).toString("base64");
    if (req.url !== "/api/auth/oauth2/token" || req.headers.authorization !== `Basic ${basic}`) {
      res.writeHead(401).end();
      return;
    }
    grants.push(new URLSearchParams(body));
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ access_token: `token-${grants.length}`, expires_in: 3600 }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address() as { port: number };
afterAll(() => server.close());

test("a client credentials token for Keelson's audience, reused until it nears expiry", async () => {
  const token = accessToken({
    apiUrl: `http://127.0.0.1:${port}`,
    clientId: "client 1",
    clientSecret: "secret",
    scopes: ["countersign:write", "evidence:write"],
  });
  expect(await token()).toBe("token-1");
  expect(await token()).toBe("token-1");
  expect(grants).toHaveLength(1);
  expect(Object.fromEntries(grants[0] as URLSearchParams)).toEqual({
    grant_type: "client_credentials",
    scope: "countersign:write evidence:write",
    resource: "https://api.keelson.finance",
  });
});
