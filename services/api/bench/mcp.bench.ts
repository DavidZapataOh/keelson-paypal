// Loads reflect-metadata before anything pulls in @keelson/attest (see tee/attest.ts).
import "../src/tee/attest.ts";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { storeMandate } from "@keelson/agent";
import { renderHarness } from "../test/render-live.ts";

// A purchase through Keelson's MCP server, driven by the MCP Inspector's CLI against the deployed
// API, the live legs and the PayPal sandbox. A fresh mandate (Trail Runner 2, US 10, at most
// $150) is held on PayPal; then, over STDIO as the operator's agent, the Inspector confirms it,
// submits the store's product and cart with what the agent read, asks for the countersign and
// reads and verifies the Alibi; over Streamable HTTP on `/mcp` it lists the tools and opens the
// Alibi's MCP App. Run as a one-off job of keelson-api (it holds the agent's OAuth client and
// key). Prints a JSON summary and exits 1 unless the purchase is captured and its card renders.
const STORE = process.env.STORE_URL ?? "https://store.keelson.finance";
const API = process.env.KEELSON_API_URL ?? "https://api.keelson.finance";
const INSPECTOR = "@modelcontextprotocol/inspector@2.14.0";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const agentId = env("DEMO_AGENT_ID");
// The server command, then `--`, then the Inspector's own options (its CLI's separator rule).
const stdio = [
  "node",
  new URL("../../mcp/dist/stdio.js", import.meta.url).pathname,
  "--",
  ...["KEELSON_CLIENT_ID", "KEELSON_CLIENT_SECRET", "KEELSON_AGENT_KEY"].flatMap((k) => [
    "-e",
    `${k}=${env(k)}`,
  ]),
  ...["-e", `AGENT_ID=${agentId}`, "-e", `STORE_URL=${STORE}`, "-e", `KEELSON_API_URL=${API}`],
];

/** One Inspector CLI run: connect, one method, the JSON envelope on stdout. */
function inspect(
  target: string[],
  args: string[],
): Promise<{ ms: number; out: Record<string, unknown> }> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      ["--yes", INSPECTOR, "--cli", ...target, ...args, "--format", "json"],
      {
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const ms = Math.round(performance.now() - started);
      try {
        resolve({ ms, out: { exit: code, ...(JSON.parse(stdout) as Record<string, unknown>) } });
      } catch {
        reject(new Error(`inspector exited ${code}: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

const call = (target: string[], tool: string, args: unknown, extra: string[] = []) =>
  inspect(target, [
    "--method",
    "tools/call",
    "--tool-name",
    tool,
    "--tool-args-json",
    JSON.stringify(args),
    ...extra,
  ]);
const structured = (r: { out: Record<string, unknown> }) =>
  (r.out.result as { structuredContent?: Record<string, unknown> } | undefined)
    ?.structuredContent ?? {};

const h = await renderHarness();
try {
  const hold = await h.openHold(15_000, (m) => storeMandate(m, STORE));
  const steps: Record<string, number> = {};

  const tools = await inspect(stdio, ["--method", "tools/list"]);
  steps.list = tools.ms;
  const confirm = await call(stdio, "keelson.confirm_mandate", { mandateId: hold.mid, agentId });
  steps.confirm = confirm.ms;

  const product = await (await fetch(`${STORE}/api/products/trail-runner-2`)).json();
  const submitted = await call(stdio, "keelson.submit_evidence", {
    mandateId: hold.mid,
    lines: [{ productUrl: `${STORE}/products/trail-runner-2`, size: "10", qty: 1 }],
    observation: `Product page ${STORE}/products/trail-runner-2:\n${JSON.stringify(product)}`,
  });
  steps.evidence = submitted.ms;
  const evidence = structured(submitted);

  const signed = await call(stdio, "keelson.request_countersign", {
    mandateId: hold.mid,
    evidenceRoot: evidence.evidenceRoot,
    cart: evidence.cart,
    agentId,
  });
  steps.countersign = signed.ms;
  const purchase = structured(signed);
  const purchaseId = purchase.purchaseId as string;

  const alibi = await call(stdio, "keelson.get_alibi", { purchaseId });
  steps.alibi = alibi.ms;
  const verified = await call(stdio, "keelson.verify_alibi", { purchaseId });
  steps.verify = verified.ms;

  // Over HTTP, as a remote host would, with a token for the same client.
  const token = await fetch(`${API}/api/auth/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${encodeURIComponent(env("KEELSON_CLIENT_ID"))}:${encodeURIComponent(env("KEELSON_CLIENT_SECRET"))}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "countersign:write alibis:read",
      resource: API,
    }),
  }).then(async (r) => ((await r.json()) as { access_token: string }).access_token);
  const http = [
    "--transport",
    "http",
    "--server-url",
    `${API}/mcp`,
    "--header",
    `Authorization: Bearer ${token}`,
  ];
  const remote = await inspect(http, ["--method", "tools/list"]);
  steps.httpList = remote.ms;
  const app = await call(http, "keelson.get_alibi", { purchaseId }, ["--app-info"]);
  const card = await call(http, "keelson.get_alibi", { purchaseId });
  steps.httpAlibi = card.ms;
  const view = await inspect(http, [
    "--method",
    "resources/read",
    "--uri",
    "ui://keelson/alibi.html",
  ]);

  const names = (r: { out: Record<string, unknown> }) =>
    ((r.out.result as { tools?: { name: string }[] }).tools ?? []).map((t) => t.name);
  const html =
    ((view.out.result as { contents?: { text?: string }[] }).contents?.[0]?.text as string) ?? "";
  const summary = {
    run: { store: STORE, api: API, mandate: hold.mid, authorization: hold.authorizationId },
    stdio: { tools: names(tools) },
    confirm: structured(confirm).status,
    evidence: { root: evidence.evidenceRoot, total: evidence.total },
    purchase,
    alibi: structured(alibi),
    verify: { verdict: structured(verified).verdict },
    http: {
      tools: names(remote),
      appInfo: app.out.appInfo,
      card: structured(card),
      viewBytes: Buffer.byteLength(html),
    },
    ms: steps,
  };
  console.log(JSON.stringify(summary));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### MCP purchase\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`,
    );
  }
  const ok =
    purchase.decision === "allow" &&
    purchase.state === "CAPTURED" &&
    structured(card).purchaseId === purchaseId &&
    (app.out.appInfo as { hasApp?: boolean } | undefined)?.hasApp === true &&
    html.includes('<main id="alibi"');
  if (!ok) process.exitCode = 1;
} finally {
  await h.close();
}
