/**
 * Boots leg A's engine image once under the TDX leg's dstack app on Phala's on-chain KMS (Base),
 * records what the engine attests and the log keys the app derives, then deletes the CVM.
 * Phala's deploy flow for an existing `DstackApp` (docs: "Using an existing DstackApp instead of
 * deploying a new one"): provision, allow the compose hash and device on the app, commit.
 *
 *   node scripts/rehearse.ts provision   # writes phala/rehearsal/state.json, prints the allow call
 *   node scripts/rehearse.ts commit      # boots, writes tests/fixtures/onchain-kms/*
 *   node scripts/rehearse.ts delete      # deletes the CVM
 *
 * `PHALA_CLOUD_API_KEY` reads and writes the workspace; `PAYPAL_CLIENT_ID` and
 * `PAYPAL_CLIENT_SECRET` are the sandbox app the engine boots with. The app's owner runs the
 * allow call.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  commitCvmProvision,
  createClient,
  deleteCvm,
  encryptEnvVars,
  getAppEnvEncryptPubKey,
  getCvmInfo,
  provisionCvm,
  verifyEnvEncryptPublicKeyLegacy,
} from "@phala/cloud";

const HERE = new URL("..", import.meta.url).pathname;
const registry = JSON.parse(
  await readFile(`${HERE}../../contracts/deployments/8453.json`, "utf8"),
) as { legA: { appId: string; kmsRoot: string } };
const APP_ID = registry.legA.appId.toLowerCase().replace(/^0x/, "");
const STATE = `${HERE}phala/rehearsal/state.json`;
const FIXTURES = `${HERE}tests/fixtures/onchain-kms`;
const DEPLOYER = "0x5dFE9F78E4620B93A9A847aEd24A411613BE711C";

interface State {
  token: string;
  composeHash: string;
  deviceId: string;
  kms: string;
  kmsRoot: string;
  teeToken?: string;
  cvmId?: string;
  committedAt?: number;
}

const client = createClient({ apiKey: process.env.PHALA_CLOUD_API_KEY as string });
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s.replace(/^0x/, ""), "hex"));

async function provision() {
  const compose = await readFile(`${HERE}phala/rehearsal/docker-compose.yml`, "utf8");
  // biome-ignore lint/suspicious/noExplicitAny: the SDK types the response per API version
  const app: any = await provisionCvm(client, {
    name: "keelson-engine-rehearsal",
    instance_type: "tdx.small",
    kms: "BASE",
    app_id: APP_ID,
    compose_file: {
      name: "keelson-engine-rehearsal",
      docker_compose_file: compose,
      allowed_envs: ["KEELSON_TEE_TOKEN_SHA256", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"],
      kms_enabled: true,
      gateway_enabled: true,
      public_logs: false,
      public_sysinfo: true,
      secure_time: true,
    },
  });
  const state: State = {
    token: app.token,
    composeHash: app.compose_hash,
    deviceId: app.device_id,
    kms: app.kms_info?.slug ?? app.kms_info?.id,
    kmsRoot: app.kms_info?.k256_pubkey,
  };
  if (!state.composeHash || !state.deviceId) throw new Error("no on-chain KMS metadata");
  if (state.kmsRoot?.toLowerCase().replace(/^0x/, "") !== registry.legA.kmsRoot.slice(2)) {
    throw new Error(`the provisioned KMS root ${state.kmsRoot} is not the registry's`);
  }
  await writeFile(STATE, `${JSON.stringify(state, null, 2)}\n`);
  console.log("The app's owner allows the compose and the device, then run `commit`:");
  console.log(
    `  (cd ../../contracts && forge script script/BootstrapDstackApp.s.sol --sig 'allow(bytes32,bytes32)' 0x${state.composeHash.replace(/^0x/, "")} 0x${state.deviceId.replace(/^0x/, "")} --rpc-url "$BASE_RPC_URL" --private-key "$BASE_DEPLOYER_KEY" --broadcast --slow)`,
  );
}

async function commit() {
  const state = JSON.parse(await readFile(STATE, "utf8")) as State;
  const signed = await getAppEnvEncryptPubKey(client, { app_id: APP_ID, kms: state.kms });
  const signer = verifyEnvEncryptPublicKeyLegacy(
    unhex(signed.public_key),
    unhex(signed.signature),
    APP_ID,
  );
  if (signer?.toLowerCase().replace(/^0x/, "") !== state.kmsRoot.toLowerCase().replace(/^0x/, "")) {
    throw new Error("the env encryption key is not signed by the KMS");
  }
  const env = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const teeToken = hex(randomBytes(32));
  const encrypted = await encryptEnvVars(
    [
      {
        key: "KEELSON_TEE_TOKEN_SHA256",
        value: createHash("sha256").update(teeToken).digest("hex"),
      },
      { key: "PAYPAL_CLIENT_ID", value: env("PAYPAL_CLIENT_ID") },
      { key: "PAYPAL_CLIENT_SECRET", value: env("PAYPAL_CLIENT_SECRET") },
    ],
    signed.public_key,
  );
  // biome-ignore lint/suspicious/noExplicitAny: the SDK types the response per API version
  const cvm: any = await commitCvmProvision(client, {
    token: state.token,
    app_id: APP_ID,
    encrypted_env: encrypted,
    compose_hash: state.composeHash,
    kms_id: state.kms,
    contract_address: `0x${APP_ID}`,
    deployer_address: DEPLOYER,
  });
  const committedAt = Date.now();
  await writeFile(
    STATE,
    `${JSON.stringify({ ...state, teeToken, cvmId: cvm.vm_uuid ?? cvm.id, committedAt }, null, 2)}\n`,
  );
  await capture({ ...state, teeToken, cvmId: cvm.vm_uuid ?? String(cvm.id), committedAt });
}

async function capture(state: State) {
  const id = state.cvmId as string;
  let url: string | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: the SDK types the response per API version
  let info: any;
  for (let i = 0; i < 120 && !url; i++) {
    info = await getCvmInfo(client, { id });
    const app = info.endpoints?.find((e: { app?: string }) => e.app?.includes("-8080"))?.app;
    if (info.status === "running" && app) {
      const res = await fetch(`${app}/v1/health`).catch(() => undefined);
      if (res?.ok) url = app;
    }
    if (!url) await new Promise((r) => setTimeout(r, 10_000));
  }
  if (!url) {
    // The CVM's console and container output, kept for the next attempt.
    for (const [name, link] of Object.entries((info?.logs ?? {}) as Record<string, string>)) {
      const text = await (await fetch(link)).text().catch(() => "");
      await writeFile(`${HERE}phala/rehearsal/${name}.log`, text);
    }
    throw new Error(
      `the CVM did not answer /v1/health in 20 minutes (status ${info?.status}); logs in phala/rehearsal/`,
    );
  }
  const bootToReadyMs = Date.now() - (state.committedAt as number);
  const health = (await (await fetch(`${url}/v1/health`)).json()) as {
    log_keys: { origin: string; vkey: string; public_key: string; signature_chain: string[] }[];
  };
  const attestation = await (
    await fetch(`${url}/v1/attestation`, {
      headers: { authorization: `Bearer ${state.teeToken}` },
    })
  ).json();
  await mkdir(FIXTURES, { recursive: true });
  const write = (name: string, value: unknown) =>
    writeFile(`${FIXTURES}/${name}`, `${JSON.stringify(value, null, 2)}\n`);
  await write(
    "getkey-chain.json",
    health.log_keys.map((k) => ({
      app_id: APP_ID,
      kms_root: registry.legA.kmsRoot.slice(2),
      domain: `keelson/log/${k.origin}/v1`,
      algorithm: "ed25519",
      origin: k.origin,
      vkey: k.vkey,
      public_key: k.public_key.replace(/^0x/, ""),
      chain: k.signature_chain,
    })),
  );
  await write("attest.json", attestation);
  await write("device.json", { device_id: state.deviceId.replace(/^0x/, "") });
  await write("boot-timing.json", [{ secure_time: true, boot_to_ready_ms: bootToReadyMs }]);
  console.log(`Captured from ${url} after ${bootToReadyMs} ms. Run \`delete\` now.`);
}

async function remove() {
  const state = JSON.parse(await readFile(STATE, "utf8")) as State;
  await deleteCvm(client, { id: state.cvmId as string });
  console.log(`Deleted ${state.cvmId}. The owner removes the compose hash from the app:`);
  console.log(
    `  cast send 0x${APP_ID} 'removeComposeHash(bytes32)' 0x${state.composeHash.replace(/^0x/, "")} --rpc-url "$BASE_RPC_URL" --private-key "$BASE_DEPLOYER_KEY"`,
  );
}

const step = process.argv[2];
if (step === "provision") await provision();
else if (step === "commit") await commit();
else if (step === "delete") await remove();
else throw new Error("usage: rehearse.ts provision | commit | delete");
