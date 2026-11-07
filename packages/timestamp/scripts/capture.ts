import { mkdirSync, writeFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { requestTimestamp } from "../src/request.ts";
import type { TsaId } from "../src/tsas.ts";

/** Requests one token from each TSA over a fixed imprint and writes them to `test/tokens/`. */
if (process.env.KEELSON_LIVE !== "1")
  throw new Error("set KEELSON_LIVE=1: this calls the live TSAs");

const dir = new URL("../test/tokens/", import.meta.url);
mkdirSync(dir, { recursive: true });
const imprint = sha256(utf8ToBytes("keelson.finance timestamp vector"));
const tokens: Record<string, { file: string; genTime: string; serial: string; latencyMs: number }> =
  {};
for (const tsa of ["digicert", "sigstore", "freetsa", "sectigo"] satisfies TsaId[]) {
  const stamp = await requestTimestamp(tsa, imprint, { timeoutMs: 10_000 });
  const file = `${tsa}.tst`;
  writeFileSync(new URL(file, dir), stamp.token);
  tokens[tsa] = {
    file,
    genTime: stamp.genTime.toISOString(),
    serial: stamp.serial,
    latencyMs: stamp.latencyMs,
  };
  console.info(`${tsa}: ${stamp.latencyMs} ms, ${stamp.token.length} B`);
}
const manifest = { imprint: bytesToHex(imprint), capturedAt: new Date().toISOString(), tokens };
writeFileSync(new URL("tokens.json", dir), `${JSON.stringify(manifest, null, 2)}\n`);
