/**
 * Deploys leg A under its app on Phala's on-chain KMS (Base), from `phala/app-compose.json` and
 * `phala/docker-compose.yml` as committed, so the compose hash is the one `measurements.json`
 * pins. Phala's flow for an existing `DstackApp`: provision, the app's owner allows the compose
 * (and the device), commit.
 *
 *   node scripts/deploy-onchain.ts provision   # checks the compose hash, prints the allow call
 *   node scripts/deploy-onchain.ts commit      # boots the CVM and waits for /v1/health
 *
 * Reads `PHALA_CLOUD_API_KEY`, `KEELSON_TEE_TOKEN`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and
 * `LITHIC_API_KEY`.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  commitCvmProvision,
  createClient,
  encryptEnvVars,
  getAppEnvEncryptPubKey,
  getCvmInfo,
  provisionCvm,
  verifyEnvEncryptPublicKeyLegacy,
} from "@phala/cloud";

const HERE = new URL("..", import.meta.url).pathname;
const STATE = `${HERE}phala/onchain-state.json`;
const app = JSON.parse(await readFile(`${HERE}phala/app.json`, "utf8")) as {
  app_id: string;
  instance_type: string;
  os_image: string;
  node: string;
  compose_hash: string;
};
const doc = JSON.parse(await readFile(`${HERE}phala/app-compose.json`, "utf8")) as {
  name: string;
  allowed_envs: string[];
  public_logs: boolean;
  public_sysinfo: boolean;
  secure_time: boolean;
  pre_launch_script: string;
};
const client = createClient({ apiKey: process.env.PHALA_CLOUD_API_KEY as string });
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const unhex = (s: string) => new Uint8Array(Buffer.from(s.replace(/^0x/, ""), "hex"));

async function provision() {
  // biome-ignore lint/suspicious/noExplicitAny: the SDK types the response per API version
  const p: any = await provisionCvm(client, {
    name: doc.name,
    instance_type: app.instance_type,
    image: app.os_image,
    // The node whose TDX device the app and `TDX_DEVICES` allow.
    node: app.node,
    kms: "BASE",
    app_id: app.app_id,
    compose_file: {
      name: doc.name,
      docker_compose_file: await readFile(`${HERE}phala/docker-compose.yml`, "utf8"),
      allowed_envs: doc.allowed_envs,
      kms_enabled: true,
      gateway_enabled: true,
      public_logs: doc.public_logs,
      public_sysinfo: doc.public_sysinfo,
      secure_time: doc.secure_time,
      // Pinned: the default script changes with Phala's releases, and with it the compose hash.
      pre_launch_script: doc.pre_launch_script,
    },
  });
  if (p.compose_hash !== app.compose_hash) {
    throw new Error(
      `Phala computes compose hash ${p.compose_hash}, app.json pins ${app.compose_hash}`,
    );
  }
  await writeFile(
    STATE,
    `${JSON.stringify({ token: p.token, kms: p.kms_info.slug, kmsRoot: p.kms_info.k256_pubkey, deviceId: p.device_id }, null, 2)}\n`,
  );
  console.log(
    `compose ${p.compose_hash} on device ${p.device_id}. The app's owner allows both, then run \`commit\`.`,
  );
}

async function commit() {
  const state = JSON.parse(await readFile(STATE, "utf8")) as {
    token: string;
    kms: string;
    kmsRoot: string;
  };
  const signed = await getAppEnvEncryptPubKey(client, { app_id: app.app_id, kms: state.kms });
  const signer = verifyEnvEncryptPublicKeyLegacy(
    unhex(signed.public_key),
    unhex(signed.signature),
    app.app_id,
  );
  if (signer?.replace(/^0x/, "").toLowerCase() !== state.kmsRoot.replace(/^0x/, "").toLowerCase()) {
    throw new Error("the env encryption key is not signed by the KMS");
  }
  const encrypted = await encryptEnvVars(
    [
      {
        key: "KEELSON_TEE_TOKEN_SHA256",
        value: createHash("sha256").update(env("KEELSON_TEE_TOKEN")).digest("hex"),
      },
      { key: "PAYPAL_CLIENT_ID", value: env("PAYPAL_CLIENT_ID") },
      { key: "PAYPAL_CLIENT_SECRET", value: env("PAYPAL_CLIENT_SECRET") },
      { key: "LITHIC_API_KEY", value: env("LITHIC_API_KEY") },
    ],
    signed.public_key,
  );
  // biome-ignore lint/suspicious/noExplicitAny: the SDK types the response per API version
  const cvm: any = await commitCvmProvision(client, {
    token: state.token,
    app_id: app.app_id,
    encrypted_env: encrypted,
    compose_hash: app.compose_hash,
    kms_id: state.kms,
    contract_address: `0x${app.app_id}`,
    deployer_address: env("BASE_DEPLOYER_ADDRESS"),
  });
  const id = cvm.vm_uuid ?? String(cvm.id);
  const started = Date.now();
  for (let i = 0; i < 120; i++) {
    // biome-ignore lint/suspicious/noExplicitAny: the SDK types the response per API version
    const info: any = await getCvmInfo(client, { id });
    const url = info.endpoints?.find((e: { app?: string }) => e.app?.includes("-8080"))?.app;
    if (
      info.status === "running" &&
      url &&
      (await fetch(`${url}/v1/health`).catch(() => undefined))?.ok
    ) {
      console.log(
        `leg A answers at ${url} after ${Date.now() - started} ms (CVM ${id}). Set TEE_A_URL to it.`,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(`CVM ${id} did not answer /v1/health in 20 minutes`);
}

const step = process.argv[2];
if (step === "provision") await provision();
else if (step === "commit") await commit();
else throw new Error("usage: deploy-onchain.ts provision | commit");
