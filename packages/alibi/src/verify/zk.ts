import type { BarretenbergSync } from "@aztec/bb.js";
import { deploymentsFor, registeredUserSetAbi } from "@keelson/chain";
import { BN254_FR_MODULUS } from "@keelson/core/poseidon2";
import {
  createPublicClient,
  encodeAbiParameters,
  type Hex,
  hexToBytes,
  http,
  keccak256,
  numberToHex,
} from "viem";
import { arbitrumSepolia } from "viem/chains";
import { fromBase64 } from "../b64.ts";
import type { AlibiBundle } from "../schema.ts";
import { C1_VERIFICATION_KEY } from "./c1-vk.ts";
import { C1C3_VERIFICATION_KEY } from "./c1c3-vk.ts";
import { C2B_VERIFICATION_KEY } from "./c2b-vk.ts";
import { C3_VERIFICATION_KEY } from "./c3-vk.ts";

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

/** Verifies an UltraHonk proof (keccak transcript, ZK) against verification key `vk`. */
async function verifyHonk(
  vk: string,
  bytes: Uint8Array,
  publicInputs: readonly string[],
): Promise<boolean> {
  if (bytes.length === 0 || bytes.length % 32 !== 0) return false;
  const fields: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += 32) fields.push(bytes.subarray(i, i + 32));
  const bb = await barretenberg();
  try {
    return bb.circuitVerify({
      verificationKey: fromBase64(vk),
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

/** Verifies a C1 proof against the pinned verification key. */
export function verifyC1(proof: string, publicInputs: readonly string[]): Promise<boolean> {
  return verifyHonk(C1_VERIFICATION_KEY, fromBase64(proof), publicInputs);
}

/** `SHA-256("keelson.finance")`, the RP ID hash every Keelson passkey assertion names. */
export const RP_ID_HASH = "0x1071caa839ec25d37b233c1d4b37fd3a9d1b0a09830e137e452105c07d6fc4f7";

/**
 * The public inputs C3 must carry for a mandate: `C_m, mandate_hash, user_set_root, rp_id_hash`,
 * with the passkey challenge `mandateHash` reduced modulo the field and the RP ID Keelson's.
 */
export function c3Statement(mandate: {
  mandateCommitment: string;
  mandateHash: string;
  userSetRoot: string;
}): Hex[] {
  return [
    word(BigInt(mandate.mandateCommitment)),
    word(BigInt(mandate.mandateHash) % BN254_FR_MODULUS),
    word(BigInt(mandate.userSetRoot)),
    RP_ID_HASH,
  ];
}

/**
 * Verifies a C3 `anonymous_mandate` proof against the pinned verification key: a passkey in the
 * registered-user tree `public_inputs[2]` signed the mandate `public_inputs[1]` with commitment
 * `public_inputs[0]`. Which passkey is not in the proof.
 */
export function verifyC3(proof: string, publicInputs: readonly string[]): Promise<boolean> {
  return verifyHonk(C3_VERIFICATION_KEY, fromBase64(proof), publicInputs);
}

/** A C3 proof as `GET /v1/anonymous-mandates/{mandateHash}` serves it. */
export interface AnonymousMandateProof {
  user_set_root: string;
  proof: string;
  public_inputs: readonly string[];
}

/**
 * `RegisteredUserSet.roots(root)` on Arbitrum Sepolia, where Keelson's relayer publishes every
 * root of the registered-user tree: when it was published and how many users it held, or `null`
 * when it never was or the Guardian revoked it. The RPC is trusted for this read; `rpc` replaces the chain's public one.
 */
export async function registeredUserSetRoot(
  root: string,
  opts: { rpc?: string } = {},
): Promise<{ publishedAt: Date; size: number } | null> {
  const registry = deploymentsFor(arbitrumSepolia.id).RegisteredUserSet;
  if (!registry) throw new RangeError("RegisteredUserSet is not deployed");
  const client = createPublicClient({ chain: arbitrumSepolia, transport: http(opts.rpc) });
  const [publishedAt, size, revokedAt] = await client.readContract({
    address: registry,
    abi: registeredUserSetAbi,
    functionName: "roots",
    args: [root as Hex],
  });
  return publishedAt === 0n || revokedAt !== 0n
    ? null
    : { publishedAt: new Date(Number(publishedAt) * 1000), size };
}

/**
 * What a merchant checks of a C3 proof for the countersign it holds: its public inputs are the
 * countersign's `mandateCommitment` and `mandateHash` and Keelson's RP ID hash, its root is one
 * `isRegisteredRoot` vouches for (by default, one `RegisteredUserSet` holds on chain), and it
 * verifies against the pinned key. The verifier contract alone checks only the last: any key in
 * any tree, for any RP, proves its own statement.
 */
export async function verifyAnonymousMandate(
  c3: AnonymousMandateProof,
  mandate: { mandateCommitment: string; mandateHash: string },
  isRegisteredRoot: (root: string) => Promise<boolean> = async (root) =>
    (await registeredUserSetRoot(root)) !== null,
): Promise<boolean> {
  const expected = c3Statement({ ...mandate, userSetRoot: c3.user_set_root });
  return (
    c3.public_inputs.length === expected.length &&
    expected.every((x, i) => x === c3.public_inputs[i]) &&
    (await isRegisteredRoot(c3.user_set_root)) &&
    verifyC3(c3.proof, c3.public_inputs)
  );
}

/**
 * The public inputs the composed `anonymous_purchase` proof must carry for countersign `c`: C1's
 * statement, then the countersign's `mandateHash` reduced modulo the field and `userSetRoot`.
 * The RP ID hash is pinned in the circuit.
 */
export function c1c3Statement(c: AlibiBundle["tee"]["countersign"], userSetRoot: string): Hex[] {
  return [
    ...c1Statement(c),
    word(BigInt(c.mandateHash) % BN254_FR_MODULUS),
    word(BigInt(userSetRoot)),
  ];
}

/**
 * Verifies a composed `anonymous_purchase` proof (C1 and C3 verified by recursion) against the
 * pinned key: the cart satisfies the mandate, and a registered user, the one the mandate's
 * commitment names, signed it.
 */
export function verifyC1C3(proof: string, publicInputs: readonly string[]): Promise<boolean> {
  return verifyHonk(C1C3_VERIFICATION_KEY, fromBase64(proof), publicInputs);
}

/**
 * What a merchant checks of a composed proof for the countersign it holds: its public inputs are
 * the countersign's, its root is one `isRegisteredRoot` vouches for (by default, one
 * `RegisteredUserSet` holds on chain), and it verifies.
 */
export async function verifyAnonymousPurchase(
  c1c3: AnonymousMandateProof,
  countersign: AlibiBundle["tee"]["countersign"],
  isRegisteredRoot: (root: string) => Promise<boolean> = async (root) =>
    (await registeredUserSetRoot(root)) !== null,
): Promise<boolean> {
  const expected = c1c3Statement(countersign, c1c3.user_set_root);
  return (
    c1c3.public_inputs.length === expected.length &&
    expected.every((x, i) => x === c1c3.public_inputs[i]) &&
    (await isRegisteredRoot(c1c3.user_set_root)) &&
    verifyC1C3(c1c3.proof, c1c3.public_inputs)
  );
}

/** What the C2b statement reads of a `WebFact`: the page it names and its range commitment. */
export interface WebFactStatement {
  hostHash: string;
  urlPathHash: string;
  rangeCommitment: string;
}

/**
 * The public inputs `AmberContradictionCourt` gives C2b for a conviction: the halves of the
 * `WebFact`'s range commitment, the coverage's `amberCommitment`, the page as
 * `keccak256(abi.encode(hostHash, urlPathHash))` reduced modulo the field, and the field id.
 */
export function c2bStatement(
  fact: WebFactStatement,
  amberCommitment: string,
  fieldId: number,
): Hex[] {
  const range = BigInt(fact.rangeCommitment);
  const page = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [fact.hostHash as Hex, fact.urlPathHash as Hex],
    ),
  );
  return [
    word(range >> 128n),
    word(range & ((1n << 128n) - 1n)),
    word(BigInt(amberCommitment)),
    word(BigInt(page) % BN254_FR_MODULUS),
    word(BigInt(fieldId)),
  ];
}

/**
 * Verifies a C2b `amber_contradiction` proof against the pinned key: the store's notarized answer
 * for the attested SKU holds another value of field `publicInputs[4]` than the operator committed to.
 */
export function verifyC2b(proof: Hex, publicInputs: readonly string[]): Promise<boolean> {
  return verifyHonk(C2B_VERIFICATION_KEY, hexToBytes(proof), publicInputs);
}
