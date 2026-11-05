import type { BarretenbergSync } from "@aztec/bb.js";
import { fromHex, toHex } from "./hash.ts";

/** The BN254 scalar field modulus `r`. */
export const BN254_FR_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let instance: Promise<BarretenbergSync> | undefined;

function toField(value: bigint): Uint8Array {
  if (value < 0n || value >= BN254_FR_MODULUS) {
    throw new RangeError("input is not a BN254 scalar field element");
  }
  return fromHex(value.toString(16).padStart(64, "0"));
}

/** Barretenberg Poseidon2 sponge over BN254 Fr (state 4, rate 3, `iv = len * 2^64`). */
export async function poseidon2(inputs: readonly bigint[]): Promise<bigint> {
  const fields = inputs.map(toField);
  // bb.js and its wasm are several MB: load them on first use (bb.js README, "Browser Context").
  instance ??= import("@aztec/bb.js")
    .then(({ BarretenbergSync }) => BarretenbergSync.initSingleton())
    .catch((error: unknown) => {
      instance = undefined;
      throw error;
    });
  const bb = await instance;
  const { hash } = bb.poseidon2Hash({ inputs: fields });
  return BigInt(toHex(hash));
}

/** Interprets up to 31 ASCII bytes as a big-endian field element. */
export function fieldFromAscii(tag: string): bigint {
  if (tag.length === 0) throw new RangeError("empty tag");
  for (let i = 0; i < tag.length; i++) {
    if (tag.charCodeAt(i) > 0x7f) throw new RangeError("tag is not ASCII");
  }
  const bytes = new TextEncoder().encode(tag);
  if (bytes.length > 31) throw new RangeError("tag is longer than 31 bytes");
  return BigInt(toHex(bytes));
}

export const KEELSON_MANDATE: bigint = fieldFromAscii("KEELSON_MANDATE");
