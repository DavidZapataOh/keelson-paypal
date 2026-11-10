import { encodeAbiParameters, keccak256, stringToHex } from "viem";
import { BN254_FR_MODULUS, fieldFromAscii, poseidon2 } from "./poseidon2.ts";

const KEELSON_AMBER = fieldFromAscii("KEELSON_AMBER");
/** The longest string an amber field holds, in UTF-8 bytes. */
export const AMBER_STRING_BYTES = 30;

/** What an operator attests about the item a coverage backs: the amber fields. */
export interface Amber {
  sku: string;
  size: string;
  color: string;
  /** The unit price in minor units. */
  unitMinor: bigint;
  returnsFree: boolean;
}

/** The C2b field ids: which amber field a zkTLS proof contradicts. */
export const AMBER_FIELDS = { size: 1, color: 2, unitPrice: 3, returnsFree: 4 } as const;

/** A string of up to 30 UTF-8 bytes as one field: its length times 2^248 plus its bytes read big-endian. */
export function packAmberString(s: string): bigint {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length > AMBER_STRING_BYTES) {
    throw new RangeError(`longer than ${AMBER_STRING_BYTES} bytes`);
  }
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  return acc + (BigInt(bytes.length) << 248n);
}

/**
 * The product page a `WebFact` names, as a field: `keccak256(abi.encode(hostHash, urlPathHash))`
 * mod the BN254 scalar field, with the notary's hashes of the lowercase host and the request target.
 */
export function amberProduct(url: URL): bigint {
  const hostHash = keccak256(stringToHex(url.hostname.toLowerCase()));
  const urlPathHash = keccak256(stringToHex(`${url.pathname}${url.search}`));
  const encoded = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }],
    [hostHash, urlPathHash],
  );
  return BigInt(keccak256(encoded)) % BN254_FR_MODULUS;
}

/**
 * The `amberCommitment` an operator signs into a `Coverage`: Poseidon2 over the product page, the
 * amber fields and a salt, which the C2b `amber_contradiction` circuit opens.
 */
export function amberCommitment(product: bigint, amber: Amber, salt: bigint): Promise<bigint> {
  if (amber.unitMinor < 0n || amber.unitMinor >= 1n << 64n) throw new RangeError("unitMinor");
  return poseidon2([
    KEELSON_AMBER,
    product,
    packAmberString(amber.sku),
    packAmberString(amber.size),
    packAmberString(amber.color),
    amber.unitMinor,
    amber.returnsFree ? 1n : 0n,
    salt,
  ]);
}
