import { BarretenbergSync, BN254_FR_MODULUS } from "@aztec/bb.js";
import { fromHex, toHex } from "./hash.js";

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
  instance ??= BarretenbergSync.initSingleton();
  const bb = await instance;
  const { hash } = bb.poseidon2Hash({ inputs: fields });
  return BigInt(toHex(hash));
}

/** Interprets up to 31 ASCII bytes as a big-endian field element. */
export function fieldFromAscii(tag: string): bigint {
  const bytes = new TextEncoder().encode(tag);
  if (bytes.length > 31) throw new RangeError("tag is longer than 31 bytes");
  return BigInt(toHex(bytes));
}

export const KEELSON_MANDATE: bigint = fieldFromAscii("KEELSON_MANDATE");
