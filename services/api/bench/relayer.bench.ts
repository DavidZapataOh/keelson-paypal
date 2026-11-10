// Relays real gasless deposits on Arbitrum Sepolia and prints the relayer's latency budget, from where it runs.
// Needs the API's relayer environment and KEELSON_FUNDER_KEYS (a wallet holding testnet PYUSD).
import { randomBytes } from "node:crypto";
import { KMSClient } from "@aws-sdk/client-kms";
import { createDb } from "@keelson/db";
import { createRelayer, kmsAccount, type TxRecord } from "@keelson/relayer";
import { pino } from "pino";
import {
  concat,
  encodeAbiParameters,
  type Hex,
  keccak256,
  type LocalAccount,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARBITRUM_SEPOLIA_PUBLIC_RPC } from "../src/chain/rpc.ts";

const VAULT = "0xb39898Ef4333f3CB32d1B420E744f5a1Aa2ae2Bf";
const PYUSD_DOMAIN: Hex = "0xf3ecc5aec9b5298246e45dbdcf197d113d30718459718fca6a79848cbabfacb2";
const RECEIVE = keccak256(
  stringToHex(
    "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
  ),
);
const AGENT_ID = 351n;
const AMOUNT = 1_000n;
const COUNT = Number(process.env.BENCH_COUNT ?? 200);

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
const funder = privateKeyToAccount(need("KEELSON_FUNDER_KEYS").split(",")[0] as Hex);
const { db, pool } = createDb(need("DATABASE_URL"));
const kms = new KMSClient({
  region: process.env.AWS_REGION ?? "us-west-2",
  credentials: {
    accessKeyId: need("RELAYER_AWS_ACCESS_KEY_ID"),
    secretAccessKey: need("RELAYER_AWS_SECRET_ACCESS_KEY"),
  },
});
const base = await kmsAccount({ keyId: need("RELAYER_KMS_KEY_SANDBOX"), client: kms });
const signMs: number[] = [];
const account: LocalAccount = {
  ...base,
  async signTransaction(tx, opts) {
    const started = performance.now();
    const raw = await base.signTransaction(tx, opts);
    signMs.push(performance.now() - started);
    return raw;
  },
};
const relayer = createRelayer({
  db,
  log: pino({ level: "warn" }),
  chains: {
    421614: {
      rpcUrl: need("ARBITRUM_SEPOLIA_RPC_URL"),
      fallbackRpcUrls: [ARBITRUM_SEPOLIA_PUBLIC_RPC],
      account,
    },
  },
});

async function deposit(): Promise<{ record: TxRecord; totalMs: number }> {
  const salt = `0x${randomBytes(32).toString("hex")}` as Hex;
  const nonce = keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [AGENT_ID, salt]),
  );
  const validBefore = 2n ** 256n - 1n;
  const structHash = keccak256(
    encodeAbiParameters(
      ["bytes32", "address", "address", "uint256", "uint256", "uint256", "bytes32"].map((type) => ({
        type,
      })),
      [RECEIVE, funder.address, VAULT, AMOUNT, 0n, validBefore, nonce],
    ),
  );
  const signature = await funder.sign({
    hash: keccak256(concat(["0x1901", PYUSD_DOMAIN, structHash])),
  });
  const started = performance.now();
  const record = await relayer.submit({
    chainId: 421614,
    contract: "KeelsonBondVault",
    functionName: "depositWithAuthorization",
    args: [AGENT_ID, funder.address, AMOUNT, 0n, validBefore, salt, signature],
    key: `KeelsonBondVault.deposit:${nonce}`,
  });
  return { record, totalMs: performance.now() - started };
}

const pct = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
};
function report(name: string, runs: { record: TxRecord; totalMs: number }[], signs: number[]) {
  const ok = runs.filter((r) => r.record.status === "confirmed");
  const latency = ok.map((r) => r.record.latencyMs as number);
  const before = ok.map((r) => r.totalMs - (r.record.latencyMs as number));
  const line = (label: string, v: number[]) =>
    `${label} p50 ${pct(v, 0.5)} p95 ${pct(v, 0.95)} p99 ${pct(v, 0.99)} ms`;
  console.log(
    [
      `${name}: ${ok.length}/${runs.length} confirmed`,
      line("  submission -> receipt", latency),
      line("  kms sign", signs),
      line("  simulation and checks before it", before),
      `  gas ${ok.reduce((s, r) => s + (r.record.gasUsed ?? 0n), 0n) / BigInt(ok.length || 1)} avg, effective price ${ok[0]?.record.effectiveGasPrice} wei`,
    ].join("\n"),
  );
}

const kmsRoundTrips: number[] = [];
for (let i = 0; i < 50; i++) {
  const started = performance.now();
  await base.sign?.({ hash: `0x${randomBytes(32).toString("hex")}` });
  kmsRoundTrips.push(performance.now() - started);
}
console.log(
  `kms sign round trip: p50 ${pct(kmsRoundTrips, 0.5)} p95 ${pct(kmsRoundTrips, 0.95)} ms`,
);

const sequential: { record: TxRecord; totalMs: number }[] = [];
for (let i = 0; i < COUNT; i++) sequential.push(await deposit());
report(`${COUNT} sequential`, sequential, signMs.splice(0));

const paced: Promise<{ record: TxRecord; totalMs: number }>[] = [];
for (let i = 0; i < COUNT; i++) {
  paced.push(deposit());
  await new Promise((r) => setTimeout(r, 200));
}
report(`${COUNT} at 5/s`, await Promise.all(paced), signMs.splice(0));
await pool.end();
