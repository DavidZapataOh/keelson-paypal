/**
 * Boots the enclave: sends its one `POST /v1/boot` with the configuration in `<boot.json>`, the
 * hash of the latest Arbitrum Sepolia block and nothing else.
 *
 *   node boot.ts <boot.json> [--url http://127.0.0.1:8000] [--print]
 *
 * `<boot.json>` is `{ config, token_sha256 }`, plus `paypal: { env, client_id }` when the enclave
 * reads PayPal itself. Its secret is then sent as the KMS ciphertext in the SSM parameter
 * `/keelson/leg-b/paypal-secret-ct`, with the instance role's session, which may only decrypt it
 * for the measured enclave. With `--print` the request is written to stdout and not sent.
 * Otherwise it waits for an unbooted enclave, boots it and prints the signer.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const RPC = process.env.ARBITRUM_SEPOLIA_RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc";
const WAIT_MS = 60_000;

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--"));
const print = args.includes("--print");
const urlFlag = args.indexOf("--url");
const url = urlFlag >= 0 ? args[urlFlag + 1] : "http://127.0.0.1:8000";
if (!file || !url) {
  console.error("usage: boot.ts <boot.json> [--url <url>] [--print]");
  process.exit(1);
}

async function latestBlock() {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    }),
  });
  const { result } = (await response.json()) as { result: { number: string; hash: string } };
  return { number: Number(BigInt(result.number)), hash: result.hash };
}

const IMDS = "http://169.254.169.254/latest";

/** The instance role's session and region, from IMDSv2. */
async function roleSession() {
  const token = await fetch(`${IMDS}/api/token`, {
    method: "PUT",
    headers: { "x-aws-ec2-metadata-token-ttl-seconds": "300" },
  }).then((r) => r.text());
  const get = (path: string) =>
    fetch(`${IMDS}/${path}`, { headers: { "x-aws-ec2-metadata-token": token } }).then((r) =>
      r.text(),
    );
  const role = (await get("meta-data/iam/security-credentials/")).trim();
  const c = JSON.parse(await get(`meta-data/iam/security-credentials/${role}`)) as {
    AccessKeyId: string;
    SecretAccessKey: string;
    Token: string;
  };
  return {
    region: (await get("meta-data/placement/region")).trim(),
    access_key_id: c.AccessKeyId,
    secret_access_key: c.SecretAccessKey,
    session_token: c.Token,
  };
}

const boot = JSON.parse(await readFile(file, "utf8")) as {
  paypal?: { env: string; client_id: string };
};
const request: Record<string, unknown> = { ...boot, block: await latestBlock() };
if (boot.paypal) {
  const { stdout } = await promisify(execFile)("aws", [
    "ssm",
    "get-parameter",
    "--name",
    "/keelson/leg-b/paypal-secret-ct",
    "--query",
    "Parameter.Value",
    "--output",
    "text",
  ]);
  request.paypal = { ...boot.paypal, secret_ciphertext: stdout.trim() };
  request.aws = await roleSession();
}
if (print) {
  console.log(JSON.stringify(request));
  process.exit(0);
}

/** The enclave answers 503 `not_ready` once it listens and has not been booted. */
async function unbooted() {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const status = await fetch(`${url}/v1/health`).then(
      (response) => response.status,
      () => 0,
    );
    if (status === 503) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("the enclave is not listening, or was already booted");
}

await unbooted();
const started = performance.now();
const response = await fetch(`${url}/v1/boot`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(request),
});
const body = (await response.json()) as { signer?: string };
if (!response.ok) {
  console.error(`boot refused: ${response.status} ${JSON.stringify(body)}`);
  process.exit(1);
}
console.log(
  JSON.stringify({ signer: body.signer, boot_ms: Math.round(performance.now() - started) }),
);
