/**
 * Assembles `measurements.json` from the outputs of `measure.sh`.
 *
 *   INSTANCE_TYPE=… APP_ID=… OS_IMAGE=… node scripts/measurements.ts <out-dir> <phala-dir>
 */
import { readFile, writeFile } from "node:fs/promises";
import { nitroMeasurement, tdxMeasurement } from "@keelson/attest";
import { type Json, jcs } from "@keelson/core";
import { POLICY_SET_HASH } from "@keelson/policy";
import { getComposeHash } from "@phala/cloud";

const [outDir, phalaDir] = process.argv.slice(2);
const { INSTANCE_TYPE, APP_ID, OS_IMAGE } = process.env;
if (!outDir || !phalaDir || !INSTANCE_TYPE || !APP_ID || !OS_IMAGE) {
  throw new Error(
    "usage: INSTANCE_TYPE=… APP_ID=… OS_IMAGE=… measurements.ts <out-dir> <phala-dir>",
  );
}

type Hex = `0x${string}`;

const text = (path: string) => readFile(path, "utf8");
const json = async <T>(path: string) => JSON.parse(await text(path)) as T;
const hex = (value: string) => `0x${value.replace(/^0x/, "")}` as Hex;
const bare = (value: string) => value.replace(/^0x/, "");

const ociDigest = (await text(`${outDir}/oci-digest`)).trim();

const compose = await text(`${phalaDir}/docker-compose.yml`);
if (
  !compose.includes(`${ociDigest}`) ||
  compose.match(/sha256:[0-9a-f]{64}/g)?.some((d) => d !== ociDigest)
) {
  throw new Error(`docker-compose.yml does not pin ${ociDigest} alone`);
}
const appCompose = await json<Record<string, unknown>>(`${phalaDir}/app-compose.json`);
const composeHash = getComposeHash({ ...appCompose, docker_compose_file: compose } as Parameters<
  typeof getComposeHash
>[0]);

const osImage = (
  await json<Record<string, { os_image_hash: string }>>(`${phalaDir}/os-images.json`)
)[OS_IMAGE];
if (!osImage) throw new Error(`unknown OS image ${OS_IMAGE}`);
const registers = await json<Record<"mrtd" | "rtmr0" | "rtmr1" | "rtmr2", string>>(
  `${outDir}/tdx/registers.json`,
);
const tdxResult = {
  mrtd: hex(registers.mrtd),
  rtmr: [hex(registers.rtmr0), hex(registers.rtmr1), hex(registers.rtmr2), hex("")] as [
    Hex,
    Hex,
    Hex,
    Hex,
  ],
  appId: hex(APP_ID),
  composeHash: hex(composeHash),
  osImageHash: hex(osImage.os_image_hash),
};

const eif = await json<{ Measurements: Record<string, string> }>(`${outDir}/nitro/eif.json`);
const pcr = (n: number) => hex(eif.Measurements[`PCR${n}`] ?? "");
const nitroPcrs = { 0: pcr(0), 1: pcr(1), 2: pcr(2) } as const;
const nitroCli = (await text(`${outDir}/nitro/version`)).trim().replace(/^Nitro CLI /, "");

const cargo = await text(new URL("../Cargo.toml", import.meta.url).pathname);
const version = cargo.match(/^version = "([^"]+)"/m)?.[1];
if (!version) throw new Error("no version in Cargo.toml");

const measurements = {
  v: "keelson.measurements/1",
  engine: "keelson-engine",
  version,
  oci_digest: ociDigest,
  policy_set_hash: POLICY_SET_HASH,
  tdx: {
    id: tdxMeasurement(tdxResult),
    mrtd: bare(tdxResult.mrtd),
    rtmr: tdxResult.rtmr.slice(0, 3).map(bare),
    compose_hash: composeHash,
    app_id: APP_ID,
    os_image: OS_IMAGE,
    os_image_hash: osImage.os_image_hash,
    instance_type: INSTANCE_TYPE,
  },
  nitro: {
    id: nitroMeasurement({ pcrs: nitroPcrs }),
    pcr0: bare(nitroPcrs[0]),
    pcr1: bare(nitroPcrs[1]),
    pcr2: bare(nitroPcrs[2]),
    nitro_cli: nitroCli,
  },
};

await writeFile(`${outDir}/measurements.json`, jcs(measurements as Json));
console.log(`tdx   ${measurements.tdx.id}\nnitro ${measurements.nitro.id}`);
