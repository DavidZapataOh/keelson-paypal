/**
 * Buys once through the deployed MCP server as a host signed in as the user, the way claude.ai or
 * ChatGPT does: dynamic client registration, the authorization code grant with PKCE, a mandate the
 * user approves with a passkey and a PayPal sandbox hold, evidence, a countersign Keelson closes
 * with its hosted operator's key, the capture, and the Alibi's verification. Exits non-zero on any
 * failure.
 *
 * The user's steps run in a visible Chromium: sign in, consent, approve the mandate with a passkey
 * and the hold with the sandbox buyer. Everything else is the script, over MCP only.
 *
 *   KEELSON_API       the API origin; https://api.keelson.finance by default
 *   PRODUCT_URL       the product to buy; the store's Pace Lite by default
 *   SIZE              its size; 10 by default
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { chromium } from "playwright";

const api = process.env.KEELSON_API ?? "https://api.keelson.finance";
const productUrl = process.env.PRODUCT_URL ?? "https://store.keelson.finance/products/pace-lite";
const size = process.env.SIZE ?? "10";

const step = (what: string) => console.log(`\n▸ ${what}`);
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

// The host's redirect: a loopback listener, as native MCP clients use (RFC 8252 §7.3).
const callback = createServer();
await new Promise<void>((resolve) => callback.listen(0, "127.0.0.1", resolve));
const redirectUri = `http://127.0.0.1:${(callback.address() as AddressInfo).port}/callback`;
const code = new Promise<string>((resolve, reject) => {
  callback.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", redirectUri);
    res.end("Keelson smoke: you can close this tab.");
    const got = url.searchParams.get("code");
    if (got) resolve(got);
    else reject(new Error(`authorization failed: ${url.searchParams.get("error")}`));
  });
});

step("discovery (RFC 9728, RFC 8414)");
const prm = (await (await fetch(`${api}/.well-known/oauth-protected-resource`)).json()) as {
  resource: string;
  authorization_servers: string[];
};
const issuer = prm.authorization_servers[0] as string;
const as = (await (
  await fetch(`${api}/.well-known/oauth-authorization-server${new URL(issuer).pathname}`)
).json()) as {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
};

step("dynamic client registration (RFC 7591)");
const registered = await fetch(as.registration_endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "Keelson smoke",
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
  }),
});
if (!registered.ok)
  throw new Error(`registration: ${registered.status} ${await registered.text()}`);
const { client_id: clientId } = (await registered.json()) as { client_id: string };
console.log(`client ${clientId}`);

step("sign in and consent in the browser");
const verifier = randomBytes(32).toString("base64url");
const browser = await chromium.launch({ headless: false });
const page = await (await browser.newContext()).newPage();
await page.goto(
  `${as.authorization_endpoint}?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: prm.resource,
    state: randomBytes(8).toString("hex"),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  })}`,
);
const token = await fetch(as.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code: await code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
    resource: prm.resource,
  }),
});
if (!token.ok) throw new Error(`token: ${token.status} ${await token.text()}`);
const { access_token, scope } = (await token.json()) as { access_token: string; scope: string };
console.log(`scopes: ${scope}`);
callback.close();

const mcp = new Client({ name: "keelson-smoke", version: "1.0.0" });
await mcp.connect(
  new StreamableHTTPClientTransport(new URL("/mcp", api), {
    requestInit: { headers: { authorization: `Bearer ${access_token}` } },
  }),
);

type Envelope = {
  status: string;
  next: { action: string; tool?: string; afterSeconds?: number; say: string };
  message: string;
} & Record<string, unknown>;
async function tool(name: string, args: Record<string, unknown>): Promise<Envelope> {
  const res = await mcp.callTool({ name, arguments: args });
  const value = res.structuredContent as Envelope;
  console.log(`${name}: ${value?.status ?? "?"} ${value?.message ?? JSON.stringify(res.content)}`);
  if (res.isError && value?.status !== "error") throw new Error(`${name} failed`);
  return value;
}
async function until(name: string, args: Record<string, unknown>, done: (e: Envelope) => boolean) {
  for (;;) {
    const e = await tool(name, args);
    if (done(e)) return e;
    if (e.status === "denied" || e.status === "blocked" || (e.status === "error" && !e.retryable)) {
      throw new Error(`${name}: ${e.status}: ${e.message}`);
    }
    await sleep(e.next.afterSeconds ?? 5);
  }
}

step("keelson.request_mandate");
const asked = await tool("keelson.request_mandate", {
  name: "Keelson smoke",
  reason:
    "A smoke test of a host signed in as you: it buys one pair of the store's running shoes within these limits, and nothing else.",
  // A loopback host is one Keelson does not know: within the hosted operator's lower cap.
  perPurchaseMinor: 10_000,
  totalMinor: 10_000,
  until: new Date(Date.now() + 86_400_000).toISOString(),
});
if (asked.matchNumber !== null)
  throw new Error("a request of the user's own host carries no number");
console.log("Approve the mandate with your passkey, then the PayPal sandbox hold.");
await page.goto(asked.approvalUrl as string);
const approved = await until(
  "keelson.get_request",
  { requestId: asked.requestId },
  (e) => e.status === "approved",
);
const mandateId = approved.mandateId as string;
await until("keelson.confirm_mandate", { mandateId }, (e) => e.status === "success");

step("keelson.submit_evidence and keelson.check_cart");
const sealed = await tool("keelson.submit_evidence", {
  mandateId,
  lines: [{ productUrl, size, qty: 1 }],
  observation: `Smoke test: ${productUrl}, size ${size}, in stock.`,
});
if (sealed.status !== "success") throw new Error(sealed.message);
const checked = await tool("keelson.check_cart", { mandateId, cart: sealed.cart });
if (checked.status !== "success") throw new Error(checked.next.say);

step("keelson.request_countersign, closed by Keelson's hosted operator");
const bought = await tool("keelson.request_countersign", {
  mandateId,
  evidenceRoot: sealed.evidenceRoot,
  cart: sealed.cart,
});
const purchaseId = (bought.purchaseId ??
  (bought.next as { arguments?: { purchaseId?: string } }).arguments?.purchaseId) as string;
const captured =
  bought.status === "success"
    ? bought
    : await until("keelson.get_purchase", { purchaseId }, (e) => e.status === "success");
console.log(`purchase ${purchaseId}: ${captured.state}`);

step("the Alibi verifies");
for (let i = 0; ; i++) {
  const res = await mcp.callTool({ name: "keelson.verify_alibi", arguments: { purchaseId } });
  const report = res.structuredContent as { verdict?: string; verifyUrl?: string } | undefined;
  // An Alibi is incomplete until its timestamps and anchor land; wait for them.
  if (!res.isError && report?.verdict && (report.verdict !== "incomplete" || i >= 30)) {
    console.log(`verdict ${report.verdict}: ${report.verifyUrl}`);
    if (!report.verdict.startsWith("verified")) process.exitCode = 1;
    break;
  }
  if (i >= 30) throw new Error("the Alibi was not issued in time");
  await sleep(10);
}
await mcp.close();
await browser.close();
