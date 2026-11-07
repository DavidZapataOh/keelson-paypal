import { readFileSync } from "node:fs";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { TsaId } from "../src/tsas.ts";

const dir = new URL("./tokens/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("tokens.json", dir), "utf8")) as {
  imprint: string;
  tokens: Record<TsaId, { file: string; genTime: string; serial: string }>;
};

/** The fixed imprint every captured token stamps. */
export const imprint: Uint8Array = hexToBytes(manifest.imprint);

/** Real tokens captured from each TSA over `imprint`. */
export const tokens: Record<TsaId, Uint8Array> = Object.fromEntries(
  Object.entries(manifest.tokens).map(([tsa, { file }]) => [
    tsa,
    new Uint8Array(readFileSync(new URL(file, dir))),
  ]),
) as Record<TsaId, Uint8Array>;

export const expected: Record<TsaId, { genTime: string; serial: string }> = manifest.tokens;
