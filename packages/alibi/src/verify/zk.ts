import type { BarretenbergSync } from "@aztec/bb.js";
import { BN254_FR_MODULUS } from "@keelson/core/poseidon2";
import { type Hex, hexToBytes, numberToHex } from "viem";
import { fromBase64 } from "../b64.ts";
import type { AlibiBundle } from "../schema.ts";
import { C1_VERIFICATION_KEY } from "./c1-vk.ts";

/** The generator, the first point of the Aztec Ignition CRS (`crs.aztec.network/g1.dat`). */
const G1 = `0x${"0".repeat(63)}1${"0".repeat(63)}2` as const;
/** `[x]₂` of the Ignition CRS (`crs.aztec.network/g2.dat`); bb checks it against its pinned hash. */
const G2 =
  "0x0118c4d5b837bcc2bc89b5b398b5974e9f5944073b32078b7e231fec938883b0260e01b251f6f1c7e7ff4e580791dee8ea51d87a358e038b4efe30fac09383c122febda3c0c0632a56475b4214e5615e11e6dd3f96e6cea2854a87d4dacc5e5504fc6369f7110fe3d25156c1bb9a72859cf2a04641f99ba4ee413c80da6a5fe4" as const;

let instance: Promise<BarretenbergSync> | undefined;

/**
 * Single-threaded wasm bb.js, which runs the same on a server and on a page without cross-origin
 * isolation. Verifying needs `[x]₂` only, so the CRS is the generator and `[x]₂`: no download.
 */
function barretenberg(): Promise<BarretenbergSync> {
  instance ??= import("@aztec/bb.js")
    .then(async ({ BackendType, BarretenbergSync }) => {
      const bb = await BarretenbergSync.new({ backend: BackendType.Wasm, threads: 1 });
      bb.srsInitSrs({ pointsBuf: hexToBytes(G1), numPoints: 1, g2Point: hexToBytes(G2) });
      return bb;
    })
    .catch((error: unknown) => {
      instance = undefined;
      throw error;
    });
  return instance;
}

const word = (n: bigint): Hex => numberToHex(n, { size: 32 });

/**
 * The public inputs C1 must carry for `c`: `C_m, amount, currency, category, merchant_id, now,
 * cart_hash, operator_id`, with `now` the `issuedAt` and `cart_hash` reduced modulo the field.
 */
export function c1Statement(c: AlibiBundle["tee"]["countersign"]): Hex[] {
  return [
    c.mandateCommitment as Hex,
    word(BigInt(c.amount)),
    word(BigInt(c.currency)),
    word(BigInt(c.category)),
    c.merchantId as Hex,
    word(BigInt(c.issuedAt)),
    word(BigInt(c.cartHash) % BN254_FR_MODULUS),
    word(BigInt(c.agentId)),
  ];
}

/** Verifies a C1 proof (UltraHonk, keccak transcript, ZK) against the pinned verification key. */
export async function verifyC1(proof: string, publicInputs: readonly string[]): Promise<boolean> {
  const bytes = fromBase64(proof);
  if (bytes.length === 0 || bytes.length % 32 !== 0) return false;
  const fields: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += 32) fields.push(bytes.subarray(i, i + 32));
  const bb = await barretenberg();
  try {
    return bb.circuitVerify({
      verificationKey: fromBase64(C1_VERIFICATION_KEY),
      publicInputs: publicInputs.map((p) => hexToBytes(p as Hex)),
      proof: fields,
      settings: {
        ipaAccumulation: false,
        oracleHashType: "keccak",
        disableZk: false,
        optimizedSolidityVerifier: false,
      },
    }).verified;
  } catch {
    // bb rejects a proof of the wrong shape by throwing.
    return false;
  }
}
